/**
 * Local Upstash-REST endpoint for co-located measurement runs.
 *
 * The application talks to Redis exclusively through `@upstash/redis`, whose
 * transport is the Upstash REST protocol, and PRD-C143/C141 need a cache that
 * is milliseconds away rather than a 120 ms transcontinental round trip. This
 * shim serves that protocol on localhost and forwards every command verbatim
 * to a real RESP server (redis-server on 127.0.0.1), so the application code
 * and its configuration surface stay byte-identical: point
 * UPSTASH_REDIS_REST_URL at this process and nothing else changes. When the
 * real Upstash network is used again, the env var moves back and this process
 * simply is not started.
 *
 *   node src/scripts/local-upstash-shim.mjs [--port=8079] [--redis=127.0.0.1:6379] [--token=local-dev-token]
 *   node src/scripts/local-upstash-shim.mjs --self-test
 *
 * Protocol coverage, matching what @upstash/redis@1.x sends:
 *   POST /            body: ["SET","k","v"]            -> {"result":"OK"}
 *   POST /pipeline    body: [["SET","k","v"],["GET","k"]] -> [{"result":...},...]
 *   POST /multi-exec  body: same shape, run inside MULTI/EXEC
 *   Header `Upstash-Encoding: base64` -> every string in the result is base64-encoded.
 * Errors come back as {"error": "<message>"} with HTTP 400, matching Upstash.
 */
import { createServer } from "node:http";
import { connect } from "node:net";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PORT = Number(arg("port", "8079"));
const TOKEN = arg("token", "local-dev-token");
const [REDIS_HOST, REDIS_PORT] = arg("redis", "127.0.0.1:6379").split(":");

function encodeCommand(parts) {
  let out = `*${parts.length}\r\n`;
  for (const part of parts) {
    const s = typeof part === "string" ? part : String(part);
    const bytes = Buffer.byteLength(s);
    out += `$${bytes}\r\n${s}\r\n`;
  }
  return out;
}

class RespConnection {
  constructor(host, port) {
    this.socket = connect({ host, port: Number(port) });
    this.socket.setNoDelay(true);
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.once("connect", resolveReady);
      this.socket.once("error", rejectReady);
    });
  }

  drain() {
    while (this.waiters.length > 0) {
      const parsed = this.tryParse(0);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.next);
      const waiter = this.waiters.shift();
      waiter(parsed.value);
    }
  }

  tryParse(offset) {
    if (offset >= this.buffer.length) return null;
    const lineEnd = this.buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) return null;
    const type = String.fromCharCode(this.buffer[offset]);
    const line = this.buffer.toString("utf8", offset + 1, lineEnd);
    const afterLine = lineEnd + 2;
    if (type === "+") return { value: line, next: afterLine };
    if (type === "-") return { value: { __error: line }, next: afterLine };
    if (type === ":") return { value: Number(line), next: afterLine };
    if (type === "$") {
      const size = Number(line);
      if (size === -1) return { value: null, next: afterLine };
      if (this.buffer.length < afterLine + size + 2) return null;
      return { value: this.buffer.toString("utf8", afterLine, afterLine + size), next: afterLine + size + 2 };
    }
    if (type === "*") {
      const count = Number(line);
      if (count === -1) return { value: null, next: afterLine };
      const items = [];
      let cursor = afterLine;
      for (let i = 0; i < count; i++) {
        const item = this.tryParse(cursor);
        if (!item) return null;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    throw new Error(`Unsupported RESP type byte "${type}"`);
  }

  send(parts) {
    return new Promise((resolveReply) => {
      this.waiters.push(resolveReply);
      this.socket.write(encodeCommand(parts));
    });
  }
}

let connection = null;
async function redisSend(parts) {
  if (!connection || connection.socket.destroyed) {
    connection = new RespConnection(REDIS_HOST, REDIS_PORT);
    await connection.ready;
  }
  return connection.send(parts);
}

function toRestResult(value, base64) {
  if (value === null || typeof value === "number") return value;
  if (typeof value === "string") return base64 ? Buffer.from(value, "utf8").toString("base64") : value;
  if (Array.isArray(value)) return value.map((item) => toRestResult(item, base64));
  return value;
}

const isError = (value) => typeof value === "object" && value !== null && "__error" in value;

async function runSingle(command, base64) {
  const reply = await redisSend(command);
  if (isError(reply)) return { error: reply.__error };
  return { result: toRestResult(reply, base64) };
}

async function handle(path, body, base64) {
  if (path === "/pipeline" || path === "/multi-exec") {
    if (!Array.isArray(body) || body.some((entry) => !Array.isArray(entry) || entry.length === 0))
      return { status: 400, payload: { error: "expected an array of commands" } };
    if (path === "/multi-exec") {
      await redisSend(["MULTI"]);
      for (const command of body) await redisSend(command);
      const exec = await redisSend(["EXEC"]);
      if (isError(exec)) return { status: 400, payload: { error: exec.__error } };
      if (exec === null) return { status: 400, payload: { error: "transaction aborted" } };
      return {
        status: 200,
        payload: exec.map((reply) =>
          isError(reply) ? { error: reply.__error } : { result: toRestResult(reply, base64) },
        ),
      };
    }
    const replies = [];
    for (const command of body) replies.push(await runSingle(command, base64));
    return { status: 200, payload: replies };
  }
  if (Array.isArray(body) && body.length > 0) return { status: 200, payload: await runSingle(body, base64) };
  const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length > 0) return { status: 200, payload: await runSingle(segments, base64) };
  return { status: 400, payload: { error: "empty command" } };
}

function startServer(port) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const respond = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
      };
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${TOKEN}`) return respond(401, { error: "Unauthorized" });
      let body = null;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          return respond(400, { error: "invalid JSON body" });
        }
      }
      const base64 = (req.headers["upstash-encoding"] ?? "") === "base64";
      const path = (req.url ?? "/").split("?")[0];
      try {
        const outcome = await handle(path, body, base64);
        respond(outcome.status, outcome.payload);
      } catch (err) {
        respond(500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`local-upstash-shim listening on http://127.0.0.1:${port} -> redis ${REDIS_HOST}:${REDIS_PORT}`);
  });
  return server;
}

async function selfTest() {
  const cases = [];
  const check = (name, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    cases.push(pass);
    console.log(`  [${pass ? "pass" : "FAIL"}] ${name}${pass ? "" : ` — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`);
  };
  check("RESP encode", encodeCommand(["GET", "k"]), "*2\r\n$3\r\nGET\r\n$1\r\nk\r\n");
  check("numbers stringified", encodeCommand(["EX", 60]).includes("$2\r\n60"), true);
  check("base64 walks arrays", toRestResult(["a", 1, null, ["b"]], true), ["YQ==", 1, null, ["Yg=="]]);
  check("plain passthrough", toRestResult(["a", 1, null], false), ["a", 1, null]);
  const conn = Object.create(RespConnection.prototype);
  conn.buffer = Buffer.from("+OK\r\n:5\r\n$2\r\nhi\r\n$-1\r\n*2\r\n$1\r\na\r\n:2\r\n-ERR nope\r\n");
  const seq = [];
  let parsed = conn.tryParse(0);
  while (parsed) {
    seq.push(parsed.value);
    conn.buffer = conn.buffer.subarray(parsed.next);
    parsed = conn.buffer.length > 0 ? conn.tryParse(0) : null;
  }
  check("RESP parse sequence", seq, ["OK", 5, "hi", null, ["a", 2], { __error: "ERR nope" }]);
  const failures = cases.filter((pass) => !pass).length;
  console.log(`${cases.length - failures}/${cases.length} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

if (process.argv.includes("--self-test")) await selfTest();
else startServer(PORT);
