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
    "GPT_IMAGE_ENDPOINT=\"https://example.services.ai.azure.com\"",
    "export GPT_IMAGE_DEPLOYMENT=gpt-image-2",
    "GPT_IMAGE_API_KEY='file-key-1234567890abcdefghijklmnop'",
    "MAI_IMAGE_ENDPOINT=https://ignored.example/mai/v1/images/generations",
    "",
  ].join("\n")
);

const env = { ...process.env };
delete env.MAI_IMAGE_ENDPOINT;
delete env.MAI_IMAGE_DEPLOYMENT;
delete env.MAI_IMAGE_API_KEY;
delete env.GPT_IMAGE_ENDPOINT;
delete env.GPT_IMAGE_DEPLOYMENT;
delete env.GPT_IMAGE_API_KEY;
delete env.IMAGE_DEFAULT_MODEL;
env.FOUNDRY_IMAGE_ENV_FILE = join(tmpdir(), "foundry-image-does-not-exist.env");

const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_config", arguments: {} } },
  {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "generate_image", arguments: { prompt: "x", width: 1024, height: 1536 } },
  },
  { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "generate_image", arguments: { prompt: "x" } } },
  {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "generate_image", arguments: { prompt: "x", model: "gpt-image" } },
  },
  {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "generate_image", arguments: { prompt: "x", model: "dall-e" } },
  },
  {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "generate_image", arguments: { prompt: "x", model: "gpt-image", size: "1000x1000" } },
  },
];

const child = spawn(process.execPath, [server], { env, stdio: ["pipe", "pipe", "inherit"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stdin.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");

// second instance: same missing OS env, but an env file that completes the gpt-image backend
// while MAI_IMAGE_ENDPOINT from the OS env (set here) must win over the file value.
const fileEnv = { ...env, FOUNDRY_IMAGE_ENV_FILE: envFile, MAI_IMAGE_ENDPOINT: "https://os.example/mai/v1/images/generations" };
const fileRequests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_config", arguments: {} } },
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
  const failures = [];
  const expect = (cond, msg) => cond || failures.push(msg);

  expect(byId[1]?.serverInfo?.name === "foundry-image", "initialize: serverInfo.name");
  const names = (byId[2]?.tools || []).map((t) => t.name).sort();
  expect(names.join(",") === "check_config,edit_image,generate_image", `tools/list: got ${names}`);
  expect(/Configuration incomplete/.test(byId[3]?.content?.[0]?.text), "check_config should report incomplete");
  expect(!/[A-Za-z0-9]{20,}/.test(byId[3]?.content?.[0]?.text || ""), "check_config must not leak a key-like value");
  expect(/exceeds the MAI limit/.test(byId[4]?.content?.[0]?.text), "1024x1536 must be rejected");
  expect(byId[4]?.isError === true, "rejected call sets isError");
  expect(/MAI_IMAGE_ENDPOINT is not configured/.test(byId[5]?.content?.[0]?.text), "missing config error");
  expect(/GPT_IMAGE_ENDPOINT is not configured/.test(byId[6]?.content?.[0]?.text), "gpt-image missing config error");
  expect(/model must be one of/.test(byId[7]?.content?.[0]?.text), "unknown model rejected");
  expect(/divisible by 16/.test(byId[8]?.content?.[0]?.text), "bad gpt size (not /16) rejected");
  const fileReport = JSON.parse(fileLines[1])?.result?.content?.[0]?.text || "";
  expect(/gpt-image: ready/.test(fileReport), "env file should complete the gpt-image backend");
  expect(/GPT_IMAGE_ENDPOINT: https:\/\/example\.services\.ai\.azure\.com/.test(fileReport), "env file quotes stripped");
  expect(/GPT_IMAGE_DEPLOYMENT: gpt-image-2/.test(fileReport), "env file export prefix accepted");
  expect(/MAI_IMAGE_ENDPOINT: https:\/\/os\.example/.test(fileReport), "OS env must win over the env file");
  expect(/env file: .*\(loaded\)/.test(fileReport), "check_config reports the loaded env file");
  expect(!/file-key-1234567890/.test(fileReport), "env file key must not leak");
  const gen = (byId[2]?.tools || []).find((t) => t.name === "generate_image");
  expect(gen?.inputSchema?.properties?.model?.enum?.includes("gpt-image"), "generate_image exposes model enum");

  if (failures.length) {
    console.error("FAIL\n- " + failures.join("\n- "));
    process.exit(1);
  }
  console.log("ok: handshake, tool list, guards (mai + gpt-image), check_config, env file");
}, 50);
