import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import request from "supertest";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";

/**
 * Replays the own-tenant CONTROL request of every route the live BOLA sweep recorded as
 * `own-tenant control answered 500`, and captures the exception the application actually logged.
 *
 * The sweep's artifact only carries the sanitized envelope (`INTERNAL_ERROR`), which cannot be
 * triaged. `AllExceptionsFilter` logs the message, stack, SQLSTATE, table and column to stderr as
 * JSON, so intercepting that stream for the duration of one request attributes the fault to a
 * cause instead of a status code.
 */

const PLAN = process.env.T15_PLAN ?? join(__dirname, "live", "own-tenant-500-routes.json");
const ARTIFACT = process.env.T15_ARTIFACT ?? "";
const enabled = (process.env.DATABASE_URL ?? "").length > 0 && (process.env.AUTH_SIGNING_KEYS ?? "").length > 0;
const describeIf = enabled ? describe : describe.skip;

interface PlannedRoute {
  readonly key: string;
  readonly verb: string;
  readonly path: string;
  readonly requestPath: string;
  readonly handler: string;
  readonly file: string;
}

interface Plan {
  readonly sourceOrg: string;
  readonly sourceUser: string;
  readonly routes: readonly PlannedRoute[];
}

describeIf("T15 — own-tenant 500 triage", () => {
  let seeded: SeededE2eApp;
  let baseUrl = "";
  let token = "";
  let mintedAt = 0;
  const plan = enabled ? (JSON.parse(readFileSync(PLAN, "utf8")) as Plan) : ({ sourceOrg: "", sourceUser: "", routes: [] } as Plan);
  const results: Record<string, unknown>[] = [];

  beforeAll(async () => {
    process.env.CRON_SECRET = process.env.CRON_SECRET ?? `t15-local-${randomUUID()}`;
    seeded = await createSeededE2eApp({ mirrorHttpStack: true });
    await seeded.app.listen(0);
    const address = seeded.app.getHttpServer().address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${String(port)}`;
  }, 300000);

  afterAll(async () => {
    if (ARTIFACT) {
      mkdirSync(dirname(ARTIFACT), { recursive: true });
      writeFileSync(ARTIFACT, `${JSON.stringify(results, null, 2)}\n`);
    }
    if (seeded) await seeded.close();
  });

  it("captures the logged exception for every recorded own-tenant 500", async () => {
    for (const route of plan.routes) {
      if (Date.now() - mintedAt > 60 * 1000) {
        token = await signSeededToken(seeded, plan.sourceUser, plan.sourceOrg);
        mintedAt = Date.now();
      }
      const captured: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      const patched = ((chunk: unknown, ...rest: unknown[]): boolean => {
        captured.push(typeof chunk === "string" ? chunk : String(chunk));
        return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stderr.write;
      process.stderr.write = patched;
      let status = 0;
      let body = "";
      try {
        const agent = request(baseUrl);
        const lower = route.verb.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
        let req = agent[lower](route.requestPath)
          .set("Authorization", `Bearer ${token}`)
          .set("Idempotency-Key", randomUUID())
          .timeout({ response: 30000, deadline: 35000 });
        if (route.verb !== "GET" && route.verb !== "DELETE") req = req.send({});
        const res = await req;
        status = res.status;
        body = (typeof res.text === "string" ? res.text : JSON.stringify(res.body ?? null)).slice(0, 300);
      } catch (error) {
        const s = (error as { status?: number }).status;
        status = typeof s === "number" ? s : 0;
        body = String((error as { response?: { text?: string } }).response?.text ?? (error as Error).message).slice(0, 300);
      } finally {
        process.stderr.write = original;
      }

      let message: string | null = null;
      let sqlstate: string | null = null;
      let table: string | null = null;
      let column: string | null = null;
      let frames: string[] = [];
      for (const line of captured.join("").split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed.level !== "error") continue;
        const meta = parsed.meta as Record<string, unknown> | undefined;
        if (!meta) continue;
        if (typeof meta.message === "string") message = meta.message;
        if (typeof meta.sqlstate === "string") sqlstate = meta.sqlstate;
        if (typeof meta.table === "string") table = meta.table;
        if (typeof meta.column === "string") column = meta.column;
        if (typeof meta.stack === "string")
          frames = meta.stack
            .split("\n")
            .filter((f) => f.includes("/src/") && !f.includes("node_modules"))
            .slice(0, 6)
            .map((f) => f.trim());
      }
      results.push({ ...route, status, body, message, sqlstate, table, column, frames });
      process.stdout.write(`[t15] ${String(status)} ${route.verb} ${route.requestPath} :: ${message ?? "(no log)"}\n`);
    }
    expect(results.length).toEqual(plan.routes.length);
  }, 1800000);
});
