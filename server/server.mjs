#!/usr/bin/env node
// Minimal MCP stdio server exposing an Azure AI Foundry MAI image deployment.
// Zero dependencies: raw JSON-RPC 2.0 over stdin/stdout, global fetch (Node >= 18).
//
// Configuration is read from the environment (see README):
//   MAI_IMAGE_ENDPOINT    full generation URL, ending in /mai/v1/images/generations
//   MAI_IMAGE_DEPLOYMENT  deployment name in Foundry
//   MAI_IMAGE_API_KEY     API key for the resource
//   MAI_IMAGE_OUTPUT_DIR  optional; where images land when no output_path is given

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname, basename, extname } from "node:path";
import { tmpdir } from "node:os";

const GEN_PATH = "/mai/v1/images/generations";
const EDIT_PATH = "/mai/v1/images/edits";
const MAX_PIXELS = 1048576;
const MIN_DIMENSION = 768;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const OUT_DIR = process.env.MAI_IMAGE_OUTPUT_DIR || join(tmpdir(), "mai-images");
const REQUIRED = ["MAI_IMAGE_ENDPOINT", "MAI_IMAGE_DEPLOYMENT", "MAI_IMAGE_API_KEY"];

function config(name) {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is not configured for this MCP server`);
  return value;
}

function url(kind) {
  const endpoint = config("MAI_IMAGE_ENDPOINT").replace(/\/+$/, "");
  if (!endpoint.startsWith("https://") && !endpoint.startsWith("http://localhost")) {
    throw new Error("MAI_IMAGE_ENDPOINT must be an HTTPS URL");
  }
  if (!endpoint.endsWith(GEN_PATH)) {
    throw new Error(`MAI_IMAGE_ENDPOINT must end with ${GEN_PATH}`);
  }
  return kind === "generate" ? endpoint : endpoint.slice(0, -GEN_PATH.length) + EDIT_PATH;
}

function checkDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error("width and height must be integers");
  }
  if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
    throw new Error(`width and height must each be at least ${MIN_DIMENSION} pixels`);
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(`${width}x${height} exceeds the MAI limit of ${MAX_PIXELS} pixels`);
  }
}

function decodePng(payload) {
  const b64 = payload?.data?.[0]?.b64_json;
  if (!b64) throw new Error("MAI response did not contain data[0].b64_json image data");
  const image = Buffer.from(b64, "base64");
  if (image.length < 24 || !image.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("MAI returned data that is not a valid PNG");
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
  const width = args.width ?? 1024;
  const height = args.height ?? 1024;
  checkDimensions(width, height);
  const res = await fetch(url("generate"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": config("MAI_IMAGE_API_KEY") },
    body: JSON.stringify({ model: config("MAI_IMAGE_DEPLOYMENT"), prompt: args.prompt, width, height }),
  });
  if (!res.ok) throw new Error(`MAI API rejected the request (HTTP ${res.status}): ${await apiError(res)}`);
  const path = await save(outputPath(args.output_path, stampedName("image")), decodePng(await res.json()));
  return `Image written to ${path} (${width}x${height})`;
}

async function edit(args) {
  const source = resolve(process.cwd(), args.image);
  const bytes = await readFile(source);
  const isPng = bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) throw new Error("source image must be a PNG or JPEG file");

  const form = new FormData();
  form.set("model", config("MAI_IMAGE_DEPLOYMENT"));
  form.set("prompt", args.prompt);
  form.set("image", new Blob([bytes], { type: isPng ? "image/png" : "image/jpeg" }), basename(source));

  const res = await fetch(url("edit"), {
    method: "POST",
    headers: { "api-key": config("MAI_IMAGE_API_KEY") },
    body: form,
  });
  if (!res.ok) throw new Error(`MAI API rejected the request (HTTP ${res.status}): ${await apiError(res)}`);
  const path = await save(outputPath(args.output_path, stampedName("edit")), decodePng(await res.json()));
  return `Edited image written to ${path}`;
}

function checkConfig() {
  const lines = [];
  let ok = true;
  for (const name of REQUIRED) {
    const value = (process.env[name] || "").trim();
    if (!value) {
      ok = false;
      lines.push(`${name}: MISSING`);
    } else if (name === "MAI_IMAGE_API_KEY") {
      lines.push(`${name}: set (${value.length} chars)`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  const endpoint = (process.env.MAI_IMAGE_ENDPOINT || "").trim();
  if (endpoint && !endpoint.replace(/\/+$/, "").endsWith(GEN_PATH)) {
    ok = false;
    lines.push(`MAI_IMAGE_ENDPOINT must end with ${GEN_PATH}`);
  }
  lines.push(`MAI_IMAGE_OUTPUT_DIR: ${process.env.MAI_IMAGE_OUTPUT_DIR || `(default) ${OUT_DIR}`}`);
  lines.unshift(ok ? "Configuration OK." : "Configuration incomplete.");
  if (!ok) {
    lines.push(
      "",
      "Set the missing variables once in ~/.claude/settings.json under \"env\" " +
        "(or in your OS environment) and restart Claude Code. See the setup skill."
    );
  }
  return lines.join("\n");
}

const TOOLS = [
  {
    name: "check_config",
    description:
      "Report whether the Foundry image server is configured (which environment variables are " +
      "set, endpoint and deployment in use, output directory). Never reveals the API key. " +
      "Call this first when a generation fails with a configuration error.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "generate_image",
    description:
      "Generate a PNG image with gpt-image-2 on Azure AI Foundry. The image is written to disk " +
      "and the tool returns its path; it is not returned inline. Use a detailed prompt covering " +
      "subject, style, composition, lighting and colors. Each side must be at least 768 pixels " +
      "and width x height must not exceed 1048576 pixels, so 1024x1024, 768x1024 and 1024x768 " +
      "are valid but 1024x1536 is not.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Description of the image to generate." },
        width: { type: "integer", description: "Image width in pixels. Default 1024." },
        height: { type: "integer", description: "Image height in pixels. Default 1024." },
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
      "Edit an existing PNG or JPEG with gpt-image-2 on Azure AI Foundry, following a text " +
      "instruction. The result is written to disk as a PNG and the tool returns its path. " +
      "The source file is never modified.",
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "Path to the source PNG or JPEG." },
        prompt: { type: "string", description: "What to change in the image." },
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
      serverInfo: { name: "foundry-image", version: "1.0.0" },
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
