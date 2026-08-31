import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import process from "node:process";

const drillArgs = process.argv.slice(2);
const stateFilePath =
  drillArgs.find((a) => a.startsWith("--state-file="))?.slice(13) ??
  `${tmpdir()}/alert-drill-ack.json`;

function persistState(state) {
  try {
    mkdirSync(dirname(stateFilePath), { recursive: true });
    writeFileSync(stateFilePath, JSON.stringify(state));
  } catch {
    void 0;
  }
}

const webhookUrl = process.env.ALERT_WEBHOOK_URL ?? null;

if (!webhookUrl) {
  process.stderr.write(
    "ALERT_WEBHOOK_URL is not set.\n" +
      "This drill cannot run: there is no endpoint to deliver to.\n" +
      "Set ALERT_WEBHOOK_URL to your Slack incoming webhook, PagerDuty Events API URL,\n" +
      "or any HTTP endpoint that your on-call team monitors.\n" +
      "Exiting with code 2 (missing prerequisite).\n",
  );
  process.exit(2);
}

const nonce = randomBytes(8).toString("hex");
const sentAt = new Date().toISOString();

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

const heartbeat = {
  alertId: "heartbeat",
  synthetic: true,
  drillEvent: true,
  nonce,
  message:
    "StreamlineOS alert drill — confirm receipt by entering the nonce shown on your terminal",
  owner: "platform-reliability",
  severity: "drill",
  sentAt,
};

process.stderr.write(`Sending drill heartbeat to ${webhookUrl} ...\n`);

try {
  await postJson(webhookUrl, heartbeat);
} catch (err) {
  process.stderr.write(
    `Delivery failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.stderr.write(
    "The webhook endpoint is unreachable or returned a non-2xx status.\n" +
      "Fix the delivery path before trusting this alert channel.\n",
  );
  process.exit(1);
}

process.stderr.write(`Heartbeat delivered. Nonce: ${nonce}\n`);
process.stderr.write(
  `\nOpen your alert channel now and find the drill message with nonce "${nonce}".\n`,
);

if (!process.stdin.isTTY) {
  const nonInteractiveState = { delivered: true, acked: null, nonce, sentAt };
  persistState(nonInteractiveState);
  process.stdout.write(
    JSON.stringify({
      delivered: true,
      acked: false,
      nonce,
      sentAt,
      reason:
        "Non-interactive mode: heartbeat was delivered but operator ACK was not confirmed. " +
        "Run interactively to complete the ACK step.",
    }) + "\n",
  );
  process.stderr.write(
    "Non-interactive mode: exiting with code 3 (delivered, ACK not confirmed).\n" +
      "A webhook that 200s into a dead channel is indistinguishable from one that works — " +
      "run this script in an interactive terminal to confirm a human can actually read the alert.\n",
  );
  process.exit(3);
}

const rl = createInterface({ input: process.stdin, output: process.stderr });

const answer = await new Promise((resolve) => {
  rl.question(
    `\nEnter the nonce from your alert channel to confirm ACK (or 'skip'): `,
    resolve,
  );
});
rl.close();

if (answer.trim() === nonce) {
  const ackedAt = new Date().toISOString();
  persistState({ delivered: true, acked: true, nonce, sentAt, ackedAt });
  process.stdout.write(
    JSON.stringify({ delivered: true, acked: true, nonce, sentAt, ackedAt }) + "\n",
  );
  process.stderr.write("ACK confirmed. End-to-end alert delivery is working.\n");
  process.exit(0);
} else if (answer.trim() === "skip") {
  persistState({ delivered: true, acked: false, nonce, sentAt, reason: "operator skipped ACK" });
  process.stdout.write(
    JSON.stringify({ delivered: true, acked: false, nonce, sentAt, reason: "operator skipped ACK" }) +
      "\n",
  );
  process.stderr.write(
    "ACK skipped. Delivery was sent but not confirmed by the operator.\n",
  );
  process.exit(3);
} else {
  persistState({ delivered: true, acked: false, nonce, enteredNonce: answer.trim(), sentAt, reason: "nonce mismatch" });
  process.stderr.write(
    `Nonce mismatch. Expected "${nonce}", got "${answer.trim()}".\n` +
      "Either the alert reached a different channel or the nonce was mistyped.\n",
  );
  process.stdout.write(
    JSON.stringify({ delivered: true, acked: false, nonce, enteredNonce: answer.trim(), sentAt }) +
      "\n",
  );
  process.exit(1);
}
