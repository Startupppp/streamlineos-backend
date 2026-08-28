import * as http from "node:http";
import { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

jest.setTimeout(30_000);

const DISPATCH = path.join(__dirname, "alert-dispatch.mjs");
const ALERT_SEAM = path.join(__dirname, "alert-seam-latency.mjs");

type Payload = Record<string, unknown>;

let server: http.Server;
let webhookUrl: string;
let tempDir: string;
let collected: Payload[];

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (d: Buffer) => {
      raw += d.toString();
    });
    req.on("end", () => resolve(raw));
  });
}

function sf(name: string): string {
  return path.join(tempDir, `${name}.json`);
}

function runDispatch(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const proc = spawn("node", [DISPATCH, ...args], {
      env: { ...process.env, ALERT_WEBHOOK_URL: undefined, ...env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    proc.stdin.write(stdin ?? "");
    proc.stdin.end();
    proc.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

function runSeamChain(
  seamStdin: string,
  dispatchArgs: string[],
): Promise<{ alertCode: number; alertOut: string; dispatchCode: number; dispatchOut: string }> {
  return new Promise((resolve) => {
    const alertProc = spawn("node", [ALERT_SEAM], {
      env: process.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const dispProc = spawn("node", [DISPATCH, ...dispatchArgs], {
      env: { ...process.env, ALERT_WEBHOOK_URL: webhookUrl } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let alertOut = "";
    let dispatchOut = "";
    let alertCode = 0;

    alertProc.stdout.on("data", (chunk: Buffer) => {
      alertOut += chunk.toString();
      dispProc.stdin.write(chunk);
    });
    alertProc.stdout.on("end", () => dispProc.stdin.end());
    alertProc.stderr.on("data", () => {});

    dispProc.stdout.on("data", (d: Buffer) => {
      dispatchOut += d.toString();
    });
    dispProc.stderr.on("data", () => {});

    alertProc.stdin.write(seamStdin);
    alertProc.stdin.end();

    alertProc.on("close", (code) => {
      alertCode = code ?? 1;
    });
    dispProc.on("close", (code) => {
      resolve({ alertCode, alertOut, dispatchCode: code ?? 1, dispatchOut });
    });
  });
}

function seamLine(seam: string, latencyMs: number): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    message: "SPAN",
    name: `seam:${seam}`,
    latencyMs,
    status: "ok",
    seam,
  });
}

function fired(rows: unknown[]): string {
  return JSON.stringify({ fired: true, rows });
}

beforeAll(async () => {
  collected = [];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-delivery-"));
  server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    try {
      collected.push(JSON.parse(body) as Payload);
    } catch {}
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  webhookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  collected.splice(0);
});

describe("alert delivery", () => {
  it("(a) full chain: seam-latency breach → dispatch → receiver", async () => {
    const seamInput =
      Array.from({ length: 20 }, () => seamLine("db.query.execute", 15)).join("\n") + "\n";

    const { alertCode, alertOut, dispatchCode } = await runSeamChain(seamInput, [
      "--alert-id=seam-latency",
      `--state-file=${sf("a-seam")}`,
      "--suppression-window-minutes=0",
    ]);

    expect(alertCode).toBe(1);
    const lastAlertLine = alertOut.trim().split("\n").at(-1)!;
    const alertPayload = JSON.parse(lastAlertLine) as {
      fired: boolean;
      breached: Array<{ seam: string }>;
    };
    expect(alertPayload.fired).toBe(true);
    expect(alertPayload.breached.some((b) => b.seam === "db.query.execute")).toBe(true);

    expect(dispatchCode).toBe(0);
    expect(collected).toHaveLength(1);

    const p = collected[0];
    expect(p.alertId).toBe("seam-latency");
    expect(p.owner).toBe("platform-reliability");
    expect(p.severity).toBe("high");
    expect(typeof p.runbook).toBe("string");
    expect((p.runbook as string).includes("#seam-latency")).toBe(true);
    expect(p.fired).toBe(true);
  });

  it("(b) --test-event heartbeat is delivered to the receiver", async () => {
    const r = await runDispatch(["--test-event"], { ALERT_WEBHOOK_URL: webhookUrl });
    expect(r.code).toBe(0);
    expect(collected).toHaveLength(1);
    const p = collected[0];
    expect(p.synthetic).toBe(true);
    expect(p.testEvent).toBe(true);
    expect(p.alertId).toBe("heartbeat");
  });

  it("(c) all six registry alert IDs dispatch with correct owner/severity/runbook", async () => {
    const cases = [
      {
        alertId: "dead-outbox",
        owner: "platform-reliability",
        severity: "critical",
        anchor: "#dead-outbox",
        stdin: fired([{ org_id: "org1", event_type: "member.invited" }]),
      },
      {
        alertId: "dead-delivery",
        owner: "notifications-team",
        severity: "high",
        anchor: "#dead-delivery",
        stdin: fired([{ org_id: "org1", event_key: "billing.payment.failed" }]),
      },
      {
        alertId: "sig-failures",
        owner: "payments-team",
        severity: "high",
        anchor: "#sig-failures",
        stdin: fired([{ org_id: "org1", provider_key: "razorpay" }]),
      },
      {
        alertId: "tenant-ctx-errors",
        owner: "platform-reliability",
        severity: "critical",
        anchor: "#tenant-ctx-errors",
        stdin: JSON.stringify({
          fired: true,
          count: 1,
          matches: [{ correlationId: "corr-test", route: "/notifications" }],
        }),
      },
      {
        alertId: "p95",
        owner: "platform-reliability",
        severity: "high",
        anchor: "#p95",
        stdin: JSON.stringify({
          fired: true,
          breached: [{ endpoint: "GET /api/tickets", p95Ms: 900 }],
          hottest: [],
        }),
      },
      {
        alertId: "seam-latency",
        owner: "platform-reliability",
        severity: "high",
        anchor: "#seam-latency",
        stdin: JSON.stringify({
          fired: true,
          breached: [{ seam: "db.query.execute", p95Ms: 15, thresholdMs: 9 }],
          seams: [],
        }),
      },
    ];

    for (const { alertId, owner, severity, anchor, stdin } of cases) {
      collected.splice(0);
      const r = await runDispatch(
        [
          `--alert-id=${alertId}`,
          `--state-file=${sf(`c-${alertId}`)}`,
          "--suppression-window-minutes=0",
        ],
        { ALERT_WEBHOOK_URL: webhookUrl },
        stdin,
      );
      expect(r.code).toBe(0);
      expect(collected).toHaveLength(1);
      expect(collected[0].alertId).toBe(alertId);
      expect(collected[0].owner).toBe(owner);
      expect(collected[0].severity).toBe(severity);
      expect(typeof collected[0].runbook).toBe("string");
      expect((collected[0].runbook as string).includes(anchor)).toBe(true);
    }
  });

  it("(d) deduplication across separate process invocations", async () => {
    const stateFilePath = sf("d-dedup");
    const breach1 = fired([{ org_id: "org1", event_type: "member.invited" }]);
    const breach2 = fired([{ org_id: "org2", event_type: "payment.failed" }]);
    const dispArgs = [
      "--alert-id=dead-outbox",
      `--state-file=${stateFilePath}`,
      "--suppression-window-minutes=60",
    ];

    const r1 = await runDispatch(dispArgs, { ALERT_WEBHOOK_URL: webhookUrl }, breach1);
    expect(r1.code).toBe(0);
    expect((JSON.parse(r1.out.trim()) as { dispatched: boolean }).dispatched).toBe(true);
    expect(collected).toHaveLength(1);

    const r2 = await runDispatch(dispArgs, { ALERT_WEBHOOK_URL: webhookUrl }, breach1);
    expect(r2.code).toBe(0);
    const out2 = JSON.parse(r2.out.trim()) as { suppressed: boolean; dispatched: boolean };
    expect(out2.suppressed).toBe(true);
    expect(out2.dispatched).toBe(false);
    expect(collected).toHaveLength(1);

    const r3 = await runDispatch(dispArgs, { ALERT_WEBHOOK_URL: webhookUrl }, breach2);
    expect(r3.code).toBe(0);
    expect((JSON.parse(r3.out.trim()) as { dispatched: boolean }).dispatched).toBe(true);
    expect(collected).toHaveLength(2);
  });

  it("(e) failure modes: no ALERT_WEBHOOK_URL exits 2; connection refused exits non-zero", async () => {
    const alertInput = fired([{ org_id: "org1", event_type: "test" }]);

    const noUrl = await runDispatch(
      ["--alert-id=dead-outbox", `--state-file=${sf("e-no-url")}`],
      {},
      alertInput,
    );
    expect(noUrl.code).toBe(2);
    expect(collected).toHaveLength(0);

    const probe = http.createServer((_, res) => {
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port: closedPort } = probe.address() as AddressInfo;
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );

    const refused = await runDispatch(
      ["--alert-id=dead-outbox", `--state-file=${sf("e-refused")}`],
      { ALERT_WEBHOOK_URL: `http://127.0.0.1:${closedPort}/` },
      alertInput,
    );
    expect(refused.code).not.toBe(0);
    expect(collected).toHaveLength(0);
  });
});
