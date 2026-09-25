import http from "node:http";
import https from "node:https";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import process from "node:process";
import { URL } from "node:url";
import { Buffer } from "node:buffer";

const FAILURE_RUNBOOK =
  "architecture-refactor/prd/completion-plan.md";

const OBSERVABILITY_RUNBOOK =
  "architecture-refactor/final-refactor/evidence/40-observability/FAILURE-RUNBOOKS.md";

const REGISTRY = {
  "dead-outbox": { owner: "platform-reliability", runbookAnchor: "#dead-outbox", severity: "critical" },
  "dead-delivery": { owner: "notifications-team", runbookAnchor: "#dead-delivery", severity: "high" },
  "dead-notification-outbox": {
    owner: "notifications-team",
    runbookAnchor: "#dead-notification-outbox",
    severity: "critical",
  },
  "sig-failures": { owner: "payments-team", runbookAnchor: "#sig-failures", severity: "high" },
  "tenant-ctx-errors": { owner: "platform-reliability", runbookAnchor: "#tenant-ctx-errors", severity: "critical" },
  p95: { owner: "platform-reliability", runbookAnchor: "#p95", severity: "high" },
  "seam-latency": { owner: "platform-reliability", runbookAnchor: "#seam-latency", severity: "high" },
  "queue-age": {
    owner: "platform-reliability",
    runbookFile: FAILURE_RUNBOOK,
    runbookAnchor: "#queue-backlog",
    severity: "high",
  },
  "job-queue-age": { owner: "platform-reliability", runbookAnchor: "#job-queue-age", severity: "high" },
  "kb-indexing": { owner: "knowledge-team", runbookAnchor: "#kb-indexing", severity: "high" },
  "kb-ask": { owner: "knowledge-team", runbookAnchor: "#kb-ask", severity: "high" },
  "kb-search": { owner: "knowledge-team", runbookAnchor: "#kb-search", severity: "high" },
  "pool-saturation": { owner: "platform-reliability", runbookAnchor: "#database-cell-failure", severity: "high" },
  "tenant-cost": { owner: "platform-reliability", runbookAnchor: "#tenant-cost", severity: "high" },
  "cell-recovery": { owner: "platform-reliability", runbookAnchor: "#cell-recovery", severity: "critical" },
  "retention-dead-man": {
    owner: "platform-reliability",
    runbookFile: FAILURE_RUNBOOK,
    runbookAnchor: "#retention-dead-man",
    severity: "critical",
  },
  "workflow-stranded": {
    owner: "platform-reliability",
    runbookFile: OBSERVABILITY_RUNBOOK,
    runbookAnchor: "#workflow-stranded",
    severity: "critical",
  },
  "response-contract-violations": {
    owner: "platform-reliability",
    runbookAnchor: "#response-contract-violations",
    severity: "high",
  },
};

const RUNBOOK_BASE =
  process.env.ALERT_RUNBOOK_BASE ??
  "architecture-refactor/prd/completion-plan.md";

const DEFAULT_SUPPRESSION_WINDOW_MS = 60 * 60 * 1000;

const args = process.argv.slice(2);
const argAlertId = args.find((a) => a.startsWith("--alert-id="))?.slice(11);
const stateFilePath =
  args.find((a) => a.startsWith("--state-file="))?.slice(13) ??
  `${tmpdir()}/alert-dispatch-state.json`;
const suppressionWindowMs = (() => {
  const raw = args.find((a) => a.startsWith("--suppression-window-minutes="))?.slice(29);
  return raw === undefined ? DEFAULT_SUPPRESSION_WINDOW_MS : Math.max(0, parseInt(raw, 10)) * 60_000;
})();
const isDryRun = args.includes("--dry-run");
const isTestEvent = args.includes("--test-event");
const isSelfTest = args.includes("--self-test");

function extractBreachFingerprint(alertId, payload) {
  const parts = [alertId];
  if (Array.isArray(payload.breached) && payload.breached.length > 0) {
    const ids = payload.breached.map((b) => b.endpoint ?? b.seam ?? String(b)).sort();
    parts.push(...ids);
  } else if (Array.isArray(payload.rows) && payload.rows.length > 0) {
    const ids = payload.rows
      .map((r) => `${r.org_id ?? ""}:${r.event_type ?? r.event_key ?? r.provider_key ?? ""}`)
      .sort();
    parts.push(...ids);
  } else if (Array.isArray(payload.matches) && payload.matches.length > 0) {
    const ids = payload.matches.map((m) => m.correlationId ?? m.route ?? "").sort();
    parts.push(...ids);
  }
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function loadState(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function saveState(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state));
}

function isSuppressed(state, dedupKey, now) {
  return typeof state[dedupKey] === "number" && state[dedupKey] > now;
}

function markSuppressed(state, dedupKey, now, windowMs) {
  state[dedupKey] = now + windowMs;
  for (const k of Object.keys(state))
    if (typeof state[k] === "number" && state[k] <= now) delete state[k];
}

function postJson(url, body) {
  const payload = JSON.stringify(body);
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.statusCode);
        else reject(new Error(`HTTP ${res.statusCode}`));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function dispatch(alertId, payload, { stateFile, windowMs, dryRun, webhookUrl }) {
  const entry = REGISTRY[alertId];
  if (!entry) {
    process.stderr.write(
      `Unknown alert id: "${alertId}". Valid ids: ${Object.keys(REGISTRY).join(", ")}\n`,
    );
    process.exit(2);
  }

  const enriched = {
    ...payload,
    alertId,
    owner: entry.owner,
    severity: entry.severity,
    runbook: `${entry.runbookFile ?? RUNBOOK_BASE}${entry.runbookAnchor}`,
    sentAt: new Date().toISOString(),
  };

  const dedupKey = extractBreachFingerprint(alertId, payload);
  const state = loadState(stateFile);
  const now = Date.now();

  if (isSuppressed(state, dedupKey, now)) {
    process.stdout.write(
      JSON.stringify({
        dispatched: false,
        suppressed: true,
        dedupKey,
        alertId,
        suppressedUntil: new Date(state[dedupKey]).toISOString(),
      }) + "\n",
    );
    return { dispatched: false, suppressed: true };
  }

  if (dryRun) {
    process.stdout.write(
      JSON.stringify({ dispatched: false, dryRun: true, dedupKey, alertId, wouldSend: enriched }) +
        "\n",
    );
    return { dispatched: false, dryRun: true };
  }

  if (!webhookUrl) {
    process.stderr.write(
      "ALERT_WEBHOOK_URL is required. Set the environment variable or pass --dry-run to preview.\n",
    );
    process.exit(2);
  }

  await postJson(webhookUrl, enriched);
  markSuppressed(state, dedupKey, now, windowMs);
  saveState(stateFile, state);
  process.stdout.write(
    JSON.stringify({
      dispatched: true,
      alertId,
      dedupKey,
      owner: entry.owner,
      severity: entry.severity,
    }) + "\n",
  );
  return { dispatched: true };
}

if (isSelfTest) {
  const tempState = `${tmpdir()}/alert-dispatch-self-test-${process.pid}.json`;
  const receivedBodies = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        receivedBodies.push(JSON.parse(body));
      } catch {
        void 0;
      }
      res.writeHead(200);
      res.end("ok");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const serverUrl = `http://127.0.0.1:${port}/`;

  const opts = {
    stateFile: tempState,
    windowMs: DEFAULT_SUPPRESSION_WINDOW_MS,
    dryRun: false,
    webhookUrl: serverUrl,
  };

  const payload1 = { fired: true, rows: [{ org_id: "org_fixture_1", event_type: "member.invited" }] };
  const result1 = await dispatch("dead-outbox", payload1, opts);
  const result2 = await dispatch("dead-outbox", payload1, opts);

  const payload3 = { fired: true, rows: [{ org_id: "org_fixture_2", event_type: "payment.failed" }] };
  const result3 = await dispatch("dead-outbox", payload3, opts);

  await new Promise((resolve) => server.close(resolve));
  try {
    unlinkSync(tempState);
  } catch {
    void 0;
  }

  const checks = {
    case1Delivered: result1.dispatched === true,
    case2Suppressed: result2.suppressed === true,
    case3Delivered: result3.dispatched === true,
    serverReceivedExactlyTwo: receivedBodies.length === 2,
    case1BodyHasOwner: typeof receivedBodies[0]?.owner === "string",
    case1BodyHasRunbook: typeof receivedBodies[0]?.runbook === "string",
    case1BodyHasAlertId: receivedBodies[0]?.alertId === "dead-outbox",
    case3BodyDifferentBreach:
      receivedBodies[1]?.rows?.[0]?.org_id !== receivedBodies[0]?.rows?.[0]?.org_id,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }) + "\n");
  process.exit(pass ? 0 : 1);
}

if (isTestEvent) {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    process.stderr.write(
      "ALERT_WEBHOOK_URL is not set — test event skipped. Set this environment variable to confirm end-to-end delivery.\n",
    );
    process.exit(2);
  }
  const heartbeat = {
    alertId: "heartbeat",
    synthetic: true,
    testEvent: true,
    fired: true,
    message: "StreamlineOS alert system heartbeat — this confirms end-to-end delivery is working",
    owner: "platform-reliability",
    runbook: RUNBOOK_BASE,
    destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system",
    sentAt: new Date().toISOString(),
  };
  await postJson(webhookUrl, heartbeat);
  process.stdout.write(
    JSON.stringify({ dispatched: true, testEvent: true, sentAt: heartbeat.sentAt }) + "\n",
  );
  process.exit(0);
}

if (!argAlertId) {
  process.stderr.write(
    `--alert-id=<id> is required. Valid ids: ${Object.keys(REGISTRY).join(", ")}\n`,
  );
  process.exit(2);
}

const webhookUrl = process.env.ALERT_WEBHOOK_URL ?? null;
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = [];
for await (const line of rl) {
  if (line.trim()) lines.push(line);
}

if (lines.length === 0) {
  process.stderr.write(
    "No input on stdin. Pipe an alert script output: node alert-dead-outbox.mjs | node alert-dispatch.mjs --alert-id=dead-outbox\n",
  );
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(lines[lines.length - 1]);
} catch {
  process.stderr.write("Could not parse stdin as JSON.\n");
  process.exit(2);
}

if (!payload.fired) {
  process.stdout.write(
    JSON.stringify({ dispatched: false, alertId: argAlertId, reason: "alert not fired" }) + "\n",
  );
  process.exit(0);
}

try {
  await dispatch(argAlertId, payload, {
    stateFile: stateFilePath,
    windowMs: suppressionWindowMs,
    dryRun: isDryRun,
    webhookUrl,
  });
  process.exit(0);
} catch (err) {
  process.stderr.write(`Delivery failed: ${err.message}\n`);
  process.stdout.write(
    JSON.stringify({ dispatched: false, error: err.message, alertId: argAlertId }) + "\n",
  );
  process.exit(1);
}
