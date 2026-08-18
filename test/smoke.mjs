// Offline smoke test: spawns the server, checks the MCP handshake, tool listing,
// input guards and the check_config report. Does not call the network.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server", "server.mjs");

const env = { ...process.env };
delete env.MAI_IMAGE_ENDPOINT;
delete env.MAI_IMAGE_DEPLOYMENT;
delete env.MAI_IMAGE_API_KEY;

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
];

const child = spawn(process.execPath, [server], { env, stdio: ["pipe", "pipe", "inherit"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stdin.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");

const deadline = setTimeout(() => {
  console.error("timeout waiting for server");
  child.kill();
  process.exit(1);
}, 5000);

const check = setInterval(() => {
  const lines = out.split("\n").filter(Boolean);
  if (lines.length < requests.length) return;
  clearInterval(check);
  clearTimeout(deadline);
  child.kill();

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

  if (failures.length) {
    console.error("FAIL\n- " + failures.join("\n- "));
    process.exit(1);
  }
  console.log("ok: handshake, tool list, guards, check_config");
}, 50);
