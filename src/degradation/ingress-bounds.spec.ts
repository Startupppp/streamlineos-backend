import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ORIGIN = "https://app.example.com";
const LIMIT_BYTES = 3 * 1024;

type OrderingMode = "cors-first" | "body-first";

function startBoundServer(mode: OrderingMode): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (mode === "cors-first") {
        res.setHeader("Access-Control-Allow-Origin", ORIGIN);
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      }

      let accumulated = 0;
      req.on("data", (chunk: Buffer) => {
        accumulated += chunk.length;
        if (accumulated > LIMIT_BYTES) {
          if (!res.headersSent) {
            res.writeHead(413, { "Content-Type": "text/plain" });
            res.end("Payload Too Large");
          }
          req.destroy();
        }
      });

      req.on("end", () => {
        if (!res.headersSent) {
          if (mode === "body-first") {
            res.setHeader("Access-Control-Allow-Origin", ORIGIN);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }
      });

      req.on("error", () => {});
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });

    server.on("error", reject);
  });
}

function oversizedBody(bytes: number): string {
  return "x".repeat(bytes);
}

async function postBody(url: string, body: string): Promise<{ status: number; acao: string | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: ORIGIN },
    body,
  });
  return { status: res.status, acao: res.headers.get("access-control-allow-origin") };
}

describe("Ingress body-size limit — CORS registered BEFORE body parser (correct ordering, matches main.ts)", () => {
  let url: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ url, close } = await startBoundServer("cors-first"));
  });

  afterAll(() => close());

  it("a valid-size payload returns 200 with ACAO", async () => {
    const { status, acao } = await postBody(url, "small");
    expect(status).toBe(200);
    expect(acao).toBe(ORIGIN);
  });

  it("an oversized payload returns 413 AND carries ACAO — browser sees a 413, not a network error", async () => {
    const { status, acao } = await postBody(url, oversizedBody(LIMIT_BYTES + 100));
    expect(status).toBe(413);
    expect(acao).toBe(ORIGIN);
  });
});

describe("Ingress body-size limit — body parser BEFORE CORS (wrong ordering — regression guard, must NOT match main.ts)", () => {
  let url: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ url, close } = await startBoundServer("body-first"));
  });

  afterAll(() => close());

  it("a valid-size payload returns 200 with ACAO", async () => {
    const { status, acao } = await postBody(url, "small");
    expect(status).toBe(200);
    expect(acao).toBe(ORIGIN);
  });

  it("an oversized payload loses ACAO on the 413 — browser sees 'Network error' not a 413", async () => {
    const { status, acao } = await postBody(url, oversizedBody(LIMIT_BYTES + 100));
    expect(status).toBe(413);
    expect(acao).toBeNull();
  });
});

describe("main.ts CORS ordering — the defect is NOT present in the current codebase", () => {
  let mainSource: string;

  beforeAll(() => {
    mainSource = readFileSync(join(__dirname, "../main.ts"), "utf8");
  });

  it("enableCors is present in main.ts", () => {
    expect(mainSource).toContain("enableCors");
  });

  it("enableCors line appears before the json body-parser line", () => {
    const lines = mainSource.split("\n");
    const corsLine = lines.findIndex((l) => l.includes("enableCors("));
    const bodyParserLine = lines.findIndex((l) => l.includes('useBodyParser("json"'));

    expect(corsLine).toBeGreaterThan(-1);
    expect(bodyParserLine).toBeGreaterThan(-1);
    expect(corsLine).toBeLessThan(bodyParserLine);
  });

  it("body-parser limit is sourced from resolveAdmissionConfig (not hardcoded)", () => {
    expect(mainSource).toContain("resolveAdmissionConfig");
    expect(mainSource).toContain("maxBodyBytes");
  });
});
