// Offline smoke test: spawns the server, checks the MCP handshake, tool listing,
// input guards and the check_config report. Does not call the network.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server", "server.mjs");

const envFile = join(mkdtempSync(join(tmpdir(), "foundry-image-")), "foundry-image.env");
writeFileSync(
  envFile,
  [
    "# test env file",
    "GPT_IMAGE_ENDPOINT=\"https://file.example.services.ai.azure.com\"",
    "export GPT_IMAGE_SUNBURST_DEPLOYMENT=my-sunburst",
    "GPT_IMAGE_API_KEY='file-key-1234567890abcdefghijklmnop'",
    "",
  ].join("\n")
);

const env = { ...process.env };
for (const name of [
  "GPT_IMAGE_ENDPOINT",
  "GPT_IMAGE_API_KEY",
  "GPT_IMAGE_FLARE_DEPLOYMENT",
  "GPT_IMAGE_SUNBURST_DEPLOYMENT",
  "IMAGE_OUTPUT_DIR",
]) {
  delete env[name];
}
env.FOUNDRY_IMAGE_ENV_FILE = join(tmpdir(), "foundry-image-does-not-exist.env");

const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  call(3, "check_config", {}),
  call(4, "flare_image", { prompt: "x" }),
  call(5, "sunburst_image", { prompt: "x", size: "1000x1000" }),
  call(6, "flare_image", { prompt: "x", size: "640x640" }),
  call(7, "flare_image", { prompt: "x", size: "3840x1024" }),
  call(8, "flare_image", { prompt: "x", quality: "ultra" }),
  call(9, "flare_image", { prompt: "x", size: "wide" }),
  call(10, "generate_image", { prompt: "x" }),
  call(11, "flare_image", {}),
];

const child = spawn(process.execPath, [server], { env, stdio: ["pipe", "pipe", "inherit"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stdin.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");

// second instance: env file completes the config, while GPT_IMAGE_ENDPOINT from the OS env
// (set here) must win over the file value.
const fileEnv = { ...env, FOUNDRY_IMAGE_ENV_FILE: envFile, GPT_IMAGE_ENDPOINT: "https://os.example.services.ai.azure.com" };
const fileRequests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  call(2, "check_config", {}),
];
const fileChild = spawn(process.execPath, [server], { env: fileEnv, stdio: ["pipe", "pipe", "inherit"] });
let fileOut = "";
fileChild.stdout.on("data", (d) => (fileOut += d));
fileChild.stdin.write(fileRequests.map((r) => JSON.stringify(r)).join("\n") + "\n");

const deadline = setTimeout(() => {
  console.error("timeout waiting for server");
  child.kill();
  fileChild.kill();
  process.exit(1);
}, 5000);

const check = setInterval(() => {
  const lines = out.split("\n").filter(Boolean);
  const fileLines = fileOut.split("\n").filter(Boolean);
  if (lines.length < requests.length || fileLines.length < fileRequests.length) return;
  clearInterval(check);
  clearTimeout(deadline);
  child.kill();
  fileChild.kill();

  const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m.result]));
  const text = (id) => byId[id]?.content?.[0]?.text || "";
  const failures = [];
  const expect = (cond, msg) => cond || failures.push(msg);

  expect(byId[1]?.serverInfo?.name === "foundry-image", "initialize: serverInfo.name");
  const tools = byId[2]?.tools || [];
  const names = tools.map((t) => t.name).sort();
  expect(names.join(",") === "check_config,flare_image,sunburst_image", `tools/list: got ${names}`);
  for (const t of tools.filter((t) => t.name !== "check_config")) {
    expect(t.inputSchema?.properties?.image, `${t.name} exposes image (edit mode)`);
    expect(t.inputSchema?.properties?.quality?.enum?.includes("max"), `${t.name} exposes max quality`);
  }
  expect(/Configuration incomplete/.test(text(3)), "check_config should report incomplete");
  expect(/GPT_IMAGE_ENDPOINT: MISSING/.test(text(3)), "check_config names missing endpoint");
  expect(/\(default\) gpt-image-2\.5-flare\s+-> flare_image/.test(text(3)), "check_config shows flare default");
  expect(/GPT_IMAGE_ENDPOINT is not configured/.test(text(4)), "missing config error");
  expect(byId[4]?.isError === true, "failed call sets isError");
  expect(/divisible by 16/.test(text(5)), "size not /16 rejected");
  expect(/at least 655360 pixels/.test(text(6)), "size below pixel budget rejected");
  expect(/aspect ratio/.test(text(7)), "size wider than 3:1 rejected");
  expect(/quality must be one of/.test(text(8)), "unknown quality rejected");
  expect(/WIDTHxHEIGHT/.test(text(9)), "malformed size rejected");
  expect(/Unknown tool: generate_image/.test(text(10)), "old tool name gone");
  expect(/prompt is required/.test(text(11)), "missing prompt rejected");
  expect(!/[A-Za-z0-9]{20,}/.test(text(3)), "check_config must not leak a key-like value");

  const fileReport = JSON.parse(fileLines[1])?.result?.content?.[0]?.text || "";
  expect(/Configuration OK/.test(fileReport), "env file should complete the config");
  expect(/GPT_IMAGE_ENDPOINT: https:\/\/os\.example/.test(fileReport), "OS env must win over the env file");
  expect(/GPT_IMAGE_SUNBURST_DEPLOYMENT: my-sunburst/.test(fileReport), "env file export prefix accepted");
  expect(/env file: .*\(loaded\)/.test(fileReport), "check_config reports the loaded env file");
  expect(!/file-key-1234567890/.test(fileReport), "env file key must not leak");

  if (failures.length) {
    console.error("FAIL\n- " + failures.join("\n- "));
    process.exit(1);
  }
  console.log("ok: handshake, tool list, size/quality guards, check_config, env file");
}, 50);
