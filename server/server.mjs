#!/usr/bin/env node
// Minimal MCP stdio server exposing Azure AI Foundry image deployments.
// Zero dependencies: raw JSON-RPC 2.0 over stdin/stdout, global fetch (Node >= 18).
//
// Two backends, selected per call with the `model` argument (or IMAGE_DEFAULT_MODEL):
//
//   "mai"        MAI image API (e.g. MAI-Image-2.5-Pro)
//     MAI_IMAGE_ENDPOINT     full generation URL, ending in /mai/v1/images/generations
//     MAI_IMAGE_DEPLOYMENT   deployment name in Foundry
//     MAI_IMAGE_API_KEY      API key for the resource
//
//   "gpt-image"  OpenAI-compatible Azure image API (gpt-image-2, gpt-image-1)
//     GPT_IMAGE_ENDPOINT     resource base URL, e.g. https://<resource>.services.ai.azure.com, or the
//                            full v1 URL .../openai/v1/images/generations as shown in the Foundry portal.
//                            A legacy .../openai/deployments/<name>/images/generations URL also works.
//     GPT_IMAGE_DEPLOYMENT   deployment name in Foundry (e.g. gpt-image-2); sent as `model` on the v1 route
//     GPT_IMAGE_API_KEY      optional; falls back to MAI_IMAGE_API_KEY (same resource)
//     GPT_IMAGE_API_VERSION  optional; legacy route only, default 2025-04-01-preview
//
//   IMAGE_DEFAULT_MODEL      optional; "mai" (default) or "gpt-image"
//   MAI_IMAGE_OUTPUT_DIR     optional; where images land when no output_path is given

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname, basename, extname } from "node:path";
import { tmpdir } from "node:os";

const MAI_GEN_PATH = "/mai/v1/images/generations";
const MAI_EDIT_PATH = "/mai/v1/images/edits";
const MAI_MAX_PIXELS = 1048576;
const MAI_MIN_DIMENSION = 768;
const GPT_API_VERSION_DEFAULT = "2025-04-01-preview";
const GPT_SIZES = ["1024x1024", "1536x1024", "1024x1536"];
const GPT_QUALITIES = ["low", "medium", "high"];
const MODELS = ["mai", "gpt-image"];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const OUT_DIR = process.env.MAI_IMAGE_OUTPUT_DIR || join(tmpdir(), "mai-images");
const MAI_REQUIRED = ["MAI_IMAGE_ENDPOINT", "MAI_IMAGE_DEPLOYMENT", "MAI_IMAGE_API_KEY"];
const GPT_REQUIRED = ["GPT_IMAGE_ENDPOINT", "GPT_IMAGE_DEPLOYMENT"];

function env(name) {
  return (process.env[name] || "").trim();
}

function config(name) {
  const value = env(name);
  if (!value) throw new Error(`${name} is not configured for this MCP server`);
  return value;
}

function pickModel(args) {
  const model = (args.model || env("IMAGE_DEFAULT_MODEL") || "mai").trim();
  if (!MODELS.includes(model)) throw new Error(`model must be one of ${MODELS.join(", ")}`);
  return model;
}

// ---------- MAI backend ----------

function maiUrl(kind) {
  const endpoint = config("MAI_IMAGE_ENDPOINT").replace(/\/+$/, "");
  if (!endpoint.startsWith("https://") && !endpoint.startsWith("http://localhost")) {
    throw new Error("MAI_IMAGE_ENDPOINT must be an HTTPS URL");
  }
  if (!endpoint.endsWith(MAI_GEN_PATH)) {
    throw new Error(`MAI_IMAGE_ENDPOINT must end with ${MAI_GEN_PATH}`);
  }
  return kind === "generate" ? endpoint : endpoint.slice(0, -MAI_GEN_PATH.length) + MAI_EDIT_PATH;
}

function checkMaiDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error("width and height must be integers");
  }
  if (width < MAI_MIN_DIMENSION || height < MAI_MIN_DIMENSION) {
    throw new Error(`width and height must each be at least ${MAI_MIN_DIMENSION} pixels`);
  }
  if (width * height > MAI_MAX_PIXELS) {
    throw new Error(`${width}x${height} exceeds the MAI limit of ${MAI_MAX_PIXELS} pixels`);
  }
}

async function maiGenerate(args, width, height) {
  checkMaiDimensions(width, height);
  const res = await fetch(maiUrl("generate"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": config("MAI_IMAGE_API_KEY") },
    body: JSON.stringify({ model: config("MAI_IMAGE_DEPLOYMENT"), prompt: args.prompt, width, height }),
  });
  if (!res.ok) throw new Error(`MAI API rejected the request (HTTP ${res.status}): ${await apiError(res)}`);
  return {
    image: decodePng(await res.json(), "MAI"),
    label: `${width}x${height}, MAI ${config("MAI_IMAGE_DEPLOYMENT")}`,
  };
}

async function maiEdit(args, bytes, mime, name) {
  const form = new FormData();
  form.set("model", config("MAI_IMAGE_DEPLOYMENT"));
  form.set("prompt", args.prompt);
  form.set("image", new Blob([bytes], { type: mime }), name);
  const res = await fetch(maiUrl("edit"), {
    method: "POST",
    headers: { "api-key": config("MAI_IMAGE_API_KEY") },
    body: form,
  });
  if (!res.ok) throw new Error(`MAI API rejected the request (HTTP ${res.status}): ${await apiError(res)}`);
  return { image: decodePng(await res.json(), "MAI"), label: `MAI ${config("MAI_IMAGE_DEPLOYMENT")}` };
}

// ---------- gpt-image backend (OpenAI-compatible Azure API) ----------

function gptKey() {
  return env("GPT_IMAGE_API_KEY") || config("MAI_IMAGE_API_KEY");
}

// Two Azure routes exist. The v1 route (default) takes the deployment as `model` in the
// body and needs no api-version; the legacy deployment-scoped route is used when the
// configured endpoint already contains /openai/deployments/<name>.
function gptRoute(kind) {
  let endpoint = config("GPT_IMAGE_ENDPOINT").replace(/\/+$/, "").split("?")[0];
  if (!endpoint.startsWith("https://") && !endpoint.startsWith("http://localhost")) {
    throw new Error("GPT_IMAGE_ENDPOINT must be an HTTPS URL");
  }
  const path = kind === "generate" ? "images/generations" : "images/edits";
  endpoint = endpoint.replace(/\/images\/(generations|edits)$/, "");
  if (/\/openai\/deployments\//.test(endpoint)) {
    const version = env("GPT_IMAGE_API_VERSION") || GPT_API_VERSION_DEFAULT;
    return { url: `${endpoint}/${path}?api-version=${encodeURIComponent(version)}`, model: null };
  }
  endpoint = endpoint.replace(/\/openai\/v1$/, "");
  return { url: `${endpoint}/openai/v1/${path}`, model: config("GPT_IMAGE_DEPLOYMENT") };
}

function gptSize(args, width, height) {
  if (args.size) {
    if (!GPT_SIZES.includes(args.size) && args.size !== "auto") {
      throw new Error(`size must be one of ${GPT_SIZES.join(", ")} or auto`);
    }
    return args.size;
  }
  const ratio = width / height;
  if (ratio > 1.15) return "1536x1024";
  if (ratio < 0.87) return "1024x1536";
  return "1024x1024";
}

function gptQuality(args) {
  const quality = (args.quality || "medium").trim();
  if (!GPT_QUALITIES.includes(quality)) throw new Error(`quality must be one of ${GPT_QUALITIES.join(", ")}`);
  return quality;
}

async function gptGenerate(args, width, height) {
  const size = gptSize(args, width, height);
  const quality = gptQuality(args);
  const route = gptRoute("generate");
  const body = { prompt: args.prompt, size, quality, n: 1, output_format: "png" };
  if (route.model) body.model = route.model;
  const res = await fetch(route.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": gptKey() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gpt-image API rejected the request (HTTP ${res.status}): ${await apiError(res)}`);
  return {
    image: decodePng(await res.json(), "gpt-image"),
    label: `${size}, ${quality}, ${config("GPT_IMAGE_DEPLOYMENT")}`,
  };
}

async function gptEdit(args, bytes, mime, name) {
  const route = gptRoute("edit");
  const form = new FormData();
  if (route.model) form.set("model", route.model);
  form.set("prompt", args.prompt);
  form.set("quality", gptQuality(args));
  if (args.size) form.set("size", gptSize(args, 1, 1));
  form.set("image", new Blob([bytes], { type: mime }), name);
  const res = await fetch(route.url, {
    method: "POST",
    headers: { "api-key": gptKey() },
    body: form,
  });
  if (!res.ok) throw new Error(`gpt-image API rejected the request (HTTP ${res.status}): ${await apiError(res)}`);
  return { image: decodePng(await res.json(), "gpt-image"), label: config("GPT_IMAGE_DEPLOYMENT") };
}

// ---------- shared ----------

function decodePng(payload, backend) {
  const b64 = payload?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${backend} response did not contain data[0].b64_json image data`);
  const image = Buffer.from(b64, "base64");
  if (image.length < 24 || !image.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${backend} returned data that is not a valid PNG`);
  }
  return image;
}

async function apiError(res) {
  const text = await res.text();
  try {
    const payload = JSON.parse(text);
    const error = payload.error || payload;
    return String(error.message || error.code || text).slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

function outputPath(value, fallbackName) {
  const path = value ? resolve(process.cwd(), value) : join(OUT_DIR, fallbackName);
  if (extname(path).toLowerCase() !== ".png") throw new Error("output path must end in .png");
  return path;
}

function stampedName(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;
}

async function save(path, image) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, image);
  return path;
}

async function generate(args) {
  const model = pickModel(args);
  const width = args.width ?? 1024;
  const height = args.height ?? 1024;
  const result =
    model === "gpt-image" ? await gptGenerate(args, width, height) : await maiGenerate(args, width, height);
  const path = await save(outputPath(args.output_path, stampedName("image")), result.image);
  return `Image written to ${path} (${result.label})`;
}

async function edit(args) {
  const model = pickModel(args);
  const source = resolve(process.cwd(), args.image);
  const bytes = await readFile(source);
  const isPng = bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) throw new Error("source image must be a PNG or JPEG file");
  const mime = isPng ? "image/png" : "image/jpeg";
  const name = basename(source);
  const result = model === "gpt-image" ? await gptEdit(args, bytes, mime, name) : await maiEdit(args, bytes, mime, name);
  const path = await save(outputPath(args.output_path, stampedName("edit")), result.image);
  return `Edited image written to ${path} (${result.label})`;
}

function checkConfig() {
  const lines = [];
  const report = (name, required) => {
    const value = env(name);
    if (!value) {
      lines.push(`${name}: ${required ? "MISSING" : "(not set)"}`);
      return false;
    }
    lines.push(name.endsWith("API_KEY") ? `${name}: set (${value.length} chars)` : `${name}: ${value}`);
    return true;
  };

  lines.push("[mai backend]");
  let maiOk = MAI_REQUIRED.map((n) => report(n, true)).every(Boolean);
  const endpoint = env("MAI_IMAGE_ENDPOINT");
  if (endpoint && !endpoint.replace(/\/+$/, "").endsWith(MAI_GEN_PATH)) {
    maiOk = false;
    lines.push(`MAI_IMAGE_ENDPOINT must end with ${MAI_GEN_PATH}`);
  }

  lines.push("", "[gpt-image backend]");
  const gptSet = GPT_REQUIRED.map((n) => report(n, false)).every(Boolean);
  report("GPT_IMAGE_API_KEY", false);
  lines.push(`GPT_IMAGE_API_VERSION: ${env("GPT_IMAGE_API_VERSION") || `(default) ${GPT_API_VERSION_DEFAULT}`}`);
  const gptOk = gptSet && !!(env("GPT_IMAGE_API_KEY") || env("MAI_IMAGE_API_KEY"));
  lines.push(gptOk ? "gpt-image: ready" : "gpt-image: not configured (optional)");

  lines.push("", `IMAGE_DEFAULT_MODEL: ${env("IMAGE_DEFAULT_MODEL") || "(default) mai"}`);
  lines.push(`MAI_IMAGE_OUTPUT_DIR: ${env("MAI_IMAGE_OUTPUT_DIR") || `(default) ${OUT_DIR}`}`);

  const ok = maiOk || gptOk;
  lines.unshift(ok ? "Configuration OK." : "Configuration incomplete.");
  if (!ok) {
    lines.push(
      "",
      'Set the missing variables once in ~/.claude/settings.json under "env" ' +
        "(or in your OS environment) and restart Claude Code. See the setup skill."
    );
  }
  return lines.join("\n");
}

const MODEL_PROP = {
  type: "string",
  enum: MODELS,
  description:
    'Backend: "mai" (MAI image API, free width/height) or "gpt-image" (gpt-image-2 on the ' +
    "OpenAI-compatible Azure API; sizes 1024x1024, 1536x1024, 1024x1536). Defaults to " +
    'IMAGE_DEFAULT_MODEL or "mai".',
};

const TOOLS = [
  {
    name: "check_config",
    description:
      "Report whether the Foundry image server is configured (which environment variables are " +
      "set, endpoints and deployments in use, which backends are ready, output directory). " +
      "Never reveals the API keys. Call this first when a generation fails with a configuration error.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "generate_image",
    description:
      "Generate a PNG image on Azure AI Foundry. The image is written to disk and the tool " +
      "returns its path; it is not returned inline. Use a detailed prompt covering subject, " +
      'style, composition, lighting and colors. With model "mai": each side must be at least ' +
      "768 pixels and width x height must not exceed 1048576 pixels (1024x1024, 1280x800, " +
      '768x1024 are valid; 1024x1536 is not). With model "gpt-image" (gpt-image-2): width/height ' +
      "only pick the aspect ratio, the API renders 1536x1024 (landscape), 1024x1536 (portrait) or " +
      "1024x1024; pass `quality` low/medium/high (default medium).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Description of the image to generate." },
        width: { type: "integer", description: "Image width in pixels. Default 1024." },
        height: { type: "integer", description: "Image height in pixels. Default 1024." },
        model: MODEL_PROP,
        quality: { type: "string", enum: GPT_QUALITIES, description: "gpt-image only. Default medium." },
        size: {
          type: "string",
          description: "gpt-image only: explicit size (1024x1024, 1536x1024, 1024x1536, auto). Overrides width/height.",
        },
        output_path: {
          type: "string",
          description:
            "Where to write the PNG. Must end in .png. Relative paths resolve against the " +
            "current working directory. Defaults to a timestamped file in the output directory.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "edit_image",
    description:
      "Edit an existing PNG or JPEG on Azure AI Foundry, following a text instruction. The " +
      "result is written to disk as a PNG and the tool returns its path. The source file is " +
      'never modified. Pick the backend with `model` ("mai" or "gpt-image").',
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "Path to the source PNG or JPEG." },
        prompt: { type: "string", description: "What to change in the image." },
        model: MODEL_PROP,
        quality: { type: "string", enum: GPT_QUALITIES, description: "gpt-image only. Default medium." },
        size: { type: "string", description: "gpt-image only: output size (1024x1024, 1536x1024, 1024x1536, auto)." },
        output_path: { type: "string", description: "Where to write the result. Must end in .png." },
      },
      required: ["image", "prompt"],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(req) {
  const { method, params } = req;
  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "foundry-image", version: "1.1.0" },
    };
  }
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "ping") return {};
  if (method === "tools/call") {
    const args = params?.arguments || {};
    if (params?.name === "check_config") return { content: [{ type: "text", text: checkConfig() }] };
    if (params?.name === "generate_image") return { content: [{ type: "text", text: await generate(args) }] };
    if (params?.name === "edit_image") return { content: [{ type: "text", text: await edit(args) }] };
    throw new Error(`Unknown tool: ${params?.name}`);
  }
  throw new Error(`Unknown method: ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    if (req.id === undefined) continue; // notification: no response required
    try {
      send({ jsonrpc: "2.0", id: req.id, result: await handle(req) });
    } catch (err) {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
      });
    }
  }
});
