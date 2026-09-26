#!/usr/bin/env node
// Minimal MCP stdio server exposing two Azure AI Foundry gpt-image-2.5 deployments as tools.
// Zero dependencies: raw JSON-RPC 2.0 over stdin/stdout, global fetch (Node >= 18).
//
// Tools, one per model; each generates from a prompt, or edits when `image` is given:
//
//   flare_image      gpt-image-2.5-flare     fast, cheap, high quality for everyday images
//   sunburst_image   gpt-image-2.5-sunburst  slower, most detail and the most precise edits
//
// Both run on the OpenAI-compatible Azure v1 route (deployment sent as `model` in the body):
//   GPT_IMAGE_ENDPOINT              resource base URL, e.g. https://<resource>.services.ai.azure.com
//                                   (a full .../openai/v1/images/generations URL is trimmed to the base)
//   GPT_IMAGE_API_KEY               key of that resource
//   GPT_IMAGE_FLARE_DEPLOYMENT      optional; default gpt-image-2.5-flare
//   GPT_IMAGE_SUNBURST_DEPLOYMENT   optional; default gpt-image-2.5-sunburst
//   IMAGE_OUTPUT_DIR                optional; where images land when no output_path is given
//
// All of these can also live in an env file: ~/.claude/foundry-image.env by default, or the
// path in FOUNDRY_IMAGE_ENV_FILE. Lines are KEY=VALUE (quotes and `export ` allowed, # comments).
// A variable that is already set (non-empty) in the process environment wins over the file.

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname, basename, extname } from "node:path";
import { homedir, tmpdir } from "node:os";

const ENV_FILE =
  (process.env.FOUNDRY_IMAGE_ENV_FILE || "").trim() || join(homedir(), ".claude", "foundry-image.env");

function loadEnvFile(path) {
  if (!existsSync(path)) return false;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (/^<.*>$/.test(value)) continue; // untouched "<paste-key-here>" placeholder
    if (!(process.env[m[1]] || "").trim()) process.env[m[1]] = value;
  }
  return true;
}

const ENV_FILE_LOADED = loadEnvFile(ENV_FILE);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"];
const MIN_PIXELS = 655360;
const MAX_PIXELS = 8294400;
const MAX_EDGE = 3840;
const REQUIRED = ["GPT_IMAGE_ENDPOINT", "GPT_IMAGE_API_KEY"];

const MODELS = {
  flare: { tool: "flare_image", deploymentVar: "GPT_IMAGE_FLARE_DEPLOYMENT", fallback: "gpt-image-2.5-flare" },
  sunburst: { tool: "sunburst_image", deploymentVar: "GPT_IMAGE_SUNBURST_DEPLOYMENT", fallback: "gpt-image-2.5-sunburst" },
};

const OUT_DIR = (process.env.IMAGE_OUTPUT_DIR || "").trim() || join(tmpdir(), "foundry-images");

function env(name) {
  return (process.env[name] || "").trim();
}

function config(name) {
  const value = env(name);
  if (!value) throw new Error(`${name} is not configured for this MCP server`);
  return value;
}

function deployment(model) {
  return env(MODELS[model].deploymentVar) || MODELS[model].fallback;
}

function apiUrl(kind) {
  let endpoint = config("GPT_IMAGE_ENDPOINT").replace(/\/+$/, "").split("?")[0];
  if (!endpoint.startsWith("https://") && !endpoint.startsWith("http://localhost")) {
    throw new Error("GPT_IMAGE_ENDPOINT must be an HTTPS URL");
  }
  endpoint = endpoint.replace(/\/openai(\/.*)?$/, "");
  return `${endpoint}/openai/v1/images/${kind === "generate" ? "generations" : "edits"}`;
}

// gpt-image-2.5 takes any WxH within these bounds, or "auto" (generate: the model picks;
// edit: same aspect ratio as the input).
function checkSize(size) {
  if (size === "auto") return size;
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) throw new Error('size must be "auto" or WIDTHxHEIGHT, e.g. 1536x864');
  const w = Number(m[1]);
  const h = Number(m[2]);
  const problems = [];
  if (w % 16 || h % 16) problems.push("both sides must be divisible by 16");
  if (Math.max(w, h) > MAX_EDGE) problems.push(`no side may exceed ${MAX_EDGE} px`);
  if (Math.max(w, h) / Math.min(w, h) > 3) problems.push("aspect ratio must be between 1:3 and 3:1");
  if (w * h < MIN_PIXELS) problems.push(`at least ${MIN_PIXELS} pixels in total (e.g. 1024x640, 816x816)`);
  if (w * h > MAX_PIXELS) problems.push(`at most ${MAX_PIXELS} pixels in total (3840x2160)`);
  if (problems.length) throw new Error(`size ${size} is invalid: ${problems.join("; ")}`);
  return size;
}

// Without an explicit size, an edit keeps the input's exact dimensions when the API accepts them;
// "auto" alone keeps only the aspect ratio and may rescale (1536x864 came back as 1672x941).
function editSize(bytes, isPng) {
  if (!isPng) return "auto";
  const size = pngSize(bytes);
  try {
    return checkSize(size);
  } catch {
    return "auto";
  }
}

function checkQuality(value) {
  const quality = (value || "medium").trim();
  if (!QUALITIES.includes(quality)) throw new Error(`quality must be one of ${QUALITIES.join(", ")}`);
  return quality;
}

async function callApi(url, init) {
  const res = await fetch(url, { ...init, headers: { ...init.headers, "api-key": config("GPT_IMAGE_API_KEY") } });
  if (!res.ok) throw new Error(`Azure image API rejected the request (HTTP ${res.status}): ${await apiError(res)}`);
  return decodePng(await res.json());
}

function decodePng(payload) {
  const b64 = payload?.data?.[0]?.b64_json;
  if (!b64) throw new Error("response did not contain data[0].b64_json image data");
  const image = Buffer.from(b64, "base64");
  if (image.length < 24 || !image.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("API returned data that is not a valid PNG");
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

function pngSize(image) {
  return `${image.readUInt32BE(16)}x${image.readUInt32BE(20)}`;
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

async function run(model, args) {
  if (!args.prompt) throw new Error("prompt is required");
  const quality = checkQuality(args.quality);
  const name = deployment(model);
  let image;

  if (args.image) {
    const source = resolve(process.cwd(), args.image);
    const bytes = await readFile(source);
    const isPng = bytes.subarray(0, 8).equals(PNG_SIGNATURE);
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!isPng && !isJpeg) throw new Error("source image must be a PNG or JPEG file");
    const form = new FormData();
    form.set("model", name);
    form.set("prompt", args.prompt);
    form.set("quality", quality);
    form.set("size", checkSize(args.size || editSize(bytes, isPng)));
    form.set("image", new Blob([bytes], { type: isPng ? "image/png" : "image/jpeg" }), basename(source));
    image = await callApi(apiUrl("edit"), { method: "POST", headers: {}, body: form });
  } else {
    const body = { model: name, prompt: args.prompt, size: checkSize(args.size || "1024x1024"), quality, n: 1, output_format: "png" };
    image = await callApi(apiUrl("generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const path = await save(outputPath(args.output_path, stampedName(`${model}${args.image ? "-edit" : ""}`)), image);
  return `${args.image ? "Edited image" : "Image"} written to ${path} (${pngSize(image)}, ${quality}, ${name})`;
}

function checkConfig() {
  const lines = [];
  let ok = true;
  for (const name of REQUIRED) {
    const value = env(name);
    if (!value) {
      ok = false;
      lines.push(`${name}: MISSING`);
    } else {
      lines.push(name.endsWith("API_KEY") ? `${name}: set (${value.length} chars)` : `${name}: ${value}`);
    }
  }
  for (const model of Object.keys(MODELS)) {
    const { tool, deploymentVar, fallback } = MODELS[model];
    lines.push(`${deploymentVar}: ${env(deploymentVar) || `(default) ${fallback}`}  -> ${tool}`);
  }
  lines.push(`IMAGE_OUTPUT_DIR: ${env("IMAGE_OUTPUT_DIR") || `(default) ${OUT_DIR}`}`);
  lines.push(`env file: ${ENV_FILE} (${ENV_FILE_LOADED ? "loaded" : "not found"})`);
  lines.unshift(ok ? "Configuration OK." : "Configuration incomplete.");
  if (!ok) {
    lines.push(
      "",
      `Set the missing variables once in the env file (${ENV_FILE}), in ~/.claude/settings.json ` +
        'under "env", or in your OS environment, and restart Claude Code. See the setup skill.'
    );
  }
  return lines.join("\n");
}

function imageSchema(defaultQualityNote) {
  return {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Without `image`: full description of the picture (subject, style, composition, light, colours). " +
          "With `image`: only what to change, e.g. \"make the jacket red\".",
      },
      image: {
        type: "string",
        description: "Optional path to a PNG or JPEG. When given, the tool edits that image instead of generating a new one. The source file is never modified.",
      },
      size: {
        type: "string",
        description:
          'WIDTHxHEIGHT or "auto". Both sides divisible by 16, aspect ratio 1:3 to 3:1, no side above 3840, ' +
          "655,360 to 8,294,400 pixels in total (above 2560x1440 is experimental). Examples: 1024x1024, " +
          "1536x864 (16:9), 864x1536 (9:16), 1536x1024, 2048x1152, 3840x2160. Default: 1024x1024 when " +
          "generating; when editing, the input's own dimensions (or \"auto\", same aspect ratio, if those " +
          "fall outside the limits).",
      },
      quality: {
        type: "string",
        enum: QUALITIES,
        description: `low, medium, high, xhigh, max or auto. Cost and time rise steeply: at 1024x1024 low is ~200 output tokens, xhigh ~3,100, max ~7,000. ${defaultQualityNote}`,
      },
      output_path: {
        type: "string",
        description:
          "Where to write the PNG. Must end in .png. Relative paths resolve against the current working " +
          "directory. Defaults to a timestamped file in the output directory.",
      },
    },
    required: ["prompt"],
  };
}

const TOOLS = [
  {
    name: "flare_image",
    description:
      "Generate or edit an image with gpt-image-2.5-flare on Azure AI Foundry: the FAST, default choice. " +
      "Use it for everyday images where speed and volume matter: blog and social visuals, thumbnails, " +
      "illustrations, icons, concept sketches, drafts and variations, and quick edits. Typically 15-25 s " +
      "per image at low/medium quality. Reach for sunburst_image " +
      "instead only when the result must hold intricate detail or an edit must change exactly one thing " +
      "and leave everything else untouched. Pass `image` to edit an existing PNG/JPEG. The PNG is written " +
      "to disk and the tool returns its path; the image is not returned inline.",
    inputSchema: imageSchema("Default medium; low for drafts, high for finished work."),
  },
  {
    name: "sunburst_image",
    description:
      "Generate or edit an image with gpt-image-2.5-sunburst on Azure AI Foundry: the MOST DETAILED and " +
      "most PRECISE model, and slower than flare_image. Use it for final, polished deliverables " +
      "(campaign visuals, product shots, hero images, dense scenes with many small details) and above " +
      "all for precise edits: change one element of an existing image while keeping the rest intact, " +
      "or refine the same image over several edit rounds. Each call takes noticeably longer than " +
      "flare_image; for drafts and quick variations use flare_image. Pass `image` to edit " +
      "an existing PNG/JPEG. The PNG is written to disk and the tool returns its path; the image is not " +
      "returned inline.",
    inputSchema: imageSchema("Default medium; high or xhigh for final deliverables."),
  },
  {
    name: "check_config",
    description:
      "Report whether the Foundry image server is configured (endpoint, which deployments back " +
      "flare_image and sunburst_image, output directory, env file). Never reveals the API key. Call " +
      "this first when a call fails with a configuration error.",
    inputSchema: { type: "object", properties: {} },
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
      serverInfo: { name: "foundry-image", version: "2.0.0" },
    };
  }
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "ping") return {};
  if (method === "tools/call") {
    const args = params?.arguments || {};
    if (params?.name === "check_config") return { content: [{ type: "text", text: checkConfig() }] };
    const model = Object.keys(MODELS).find((m) => MODELS[m].tool === params?.name);
    if (model) return { content: [{ type: "text", text: await run(model, args) }] };
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
