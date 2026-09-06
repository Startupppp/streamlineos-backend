/**
 * check-alert-ack — alert acknowledgement gate.
 *
 * Reads the state file written by drill-alert-system.mjs and LOUDLY fails
 * if a human has never confirmed receipt of a drill alert.
 *
 * Exit codes (convention shared across all alert scripts):
 *   0 = verified — operator ACK recorded and within TTL
 *   1 = failed   — state file present but unacknowledged (or stale ACK)
 *   2 = prerequisite missing — state file absent or unreadable (drill never run)
 *
 * Usage:
 *   node src/scripts/check-alert-ack.mjs
 *   node src/scripts/check-alert-ack.mjs --state-file=/path/to/state.json
 *   node src/scripts/check-alert-ack.mjs --max-age-hours=48
 *   node src/scripts/check-alert-ack.mjs --self-test
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");
const stateFilePath =
  args.find((a) => a.startsWith("--state-file="))?.slice(13) ??
  `${tmpdir()}/alert-drill-ack.json`;
const maxAgeHours = Math.max(
  1,
  parseInt(args.find((a) => a.startsWith("--max-age-hours="))?.slice(16) ?? "24", 10),
);

export function readAckState(filePath) {
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    return { ok: true, data };
  } catch (e) {
    if (e.code === "ENOENT") return { ok: false, missing: true, error: null };
    return { ok: false, missing: false, error: e.message };
  }
}

export function classifyAckState(data, maxAgeMs) {
  if (!data.delivered) {
    return {
      pass: false,
      reason:
        "UNACKNOWLEDGED: drill state file exists but no delivery was recorded. " +
        "Re-run: node src/scripts/drill-alert-system.mjs",
    };
  }
  if (!data.acked) {
    return {
      pass: false,
      reason:
        "UNACKNOWLEDGED: alert drill heartbeat was delivered but the operator never confirmed the nonce. " +
        "Re-run: node src/scripts/drill-alert-system.mjs",
    };
  }
  const ackedAt = new Date(data.ackedAt ?? data.sentAt ?? 0).getTime();
  const ageMs = Date.now() - ackedAt;
  if (ageMs > maxAgeMs) {
    const ageHours = (ageMs / 3_600_000).toFixed(1);
    const threshHours = (maxAgeMs / 3_600_000).toFixed(0);
    return {
      pass: false,
      reason:
        `STALE ACK: last acknowledged ${ageHours}h ago (threshold: ${threshHours}h). ` +
        "Re-run: node src/scripts/drill-alert-system.mjs",
    };
  }
  return { pass: true, ackedAt: data.ackedAt, nonce: data.nonce };
}

if (SELF_TEST) {
  const maxAgeMs = 24 * 3_600_000;
  const now = Date.now();

  const case1 = (() => {
    const r = readAckState(join(tmpdir(), `check-alert-ack-self-test-nonexistent-${Date.now()}.json`));
    return !r.ok && r.missing === true;
  })();

  const case2 = (() => {
    const state = {
      delivered: true,
      acked: true,
      nonce: "abc123",
      sentAt: new Date(now - 60_000).toISOString(),
      ackedAt: new Date(now - 30_000).toISOString(),
    };
    const r = classifyAckState(state, maxAgeMs);
    return r.pass === true;
  })();

  const case3 = (() => {
    const state = {
      delivered: true,
      acked: false,
      nonce: "def456",
      sentAt: new Date(now - 60_000).toISOString(),
    };
    const r = classifyAckState(state, maxAgeMs);
    return r.pass === false && r.reason.includes("UNACKNOWLEDGED");
  })();

  const case4 = (() => {
    const state = {
      delivered: true,
      acked: null,
      nonce: "ghi789",
      sentAt: new Date(now - 60_000).toISOString(),
    };
    const r = classifyAckState(state, maxAgeMs);
    return r.pass === false && r.reason.includes("UNACKNOWLEDGED");
  })();

  const case5 = (() => {
    const state = {
      delivered: true,
      acked: true,
      nonce: "jkl012",
      sentAt: new Date(now - 48 * 3_600_000).toISOString(),
      ackedAt: new Date(now - 48 * 3_600_000).toISOString(),
    };
    const r = classifyAckState(state, maxAgeMs);
    return r.pass === false && r.reason.includes("STALE");
  })();

  const case6 = (() => {
    const tmpPath = join(tmpdir(), `check-ack-self-test-${process.pid}.json`);
    try {
      const state = {
        delivered: true,
        acked: true,
        nonce: "mno345",
        sentAt: new Date(now - 60_000).toISOString(),
        ackedAt: new Date(now - 30_000).toISOString(),
      };
      writeFileSync(tmpPath, JSON.stringify(state));
      const { ok, data } = readAckState(tmpPath);
      return ok && data.nonce === "mno345";
    } finally {
      try { unlinkSync(tmpPath); } catch { void 0; }
    }
  })();

  const case7 = (() => {
    const state = {
      delivered: false,
      acked: true,
      nonce: "pqr678",
      sentAt: new Date(now - 60_000).toISOString(),
    };
    const r = classifyAckState(state, maxAgeMs);
    return r.pass === false && r.reason.includes("UNACKNOWLEDGED");
  })();

  const pass = case1 && case2 && case3 && case4 && case5 && case6 && case7;
  process.stdout.write(
    JSON.stringify({
      selfTest: true,
      pass,
      checks: {
        case1MissingFileDetected: case1,
        case2AckedFreshPasses: case2,
        case3FalseAckedFails: case3,
        case4NullAckedFails: case4,
        case5StaleAckFails: case5,
        case6RoundTripStateFile: case6,
        case7UndeliveredFails: case7,
      },
    }) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

const { ok, missing, error, data } = readAckState(stateFilePath);

if (!ok) {
  if (missing) {
    process.stderr.write(
      `PREREQUISITE MISSING: no acknowledgement record at ${stateFilePath}\n` +
        "The alert drill has never been run, or was run from a different directory.\n" +
        "Run the interactive drill to record an acknowledgement:\n" +
        "  node src/scripts/drill-alert-system.mjs\n" +
        "Then re-run this check.\n",
    );
  } else {
    process.stderr.write(
      `Could not read state file at ${stateFilePath}: ${error}\n`,
    );
  }
  process.exit(2);
}

const maxAgeMs = maxAgeHours * 3_600_000;
const result = classifyAckState(data, maxAgeMs);

if (!result.pass) {
  process.stderr.write(
    `\nALERT ACKNOWLEDGEMENT FAILED\n` +
      `${result.reason}\n\n` +
      "An unacknowledged critical alert is a silent failure mode — a webhook that 200s\n" +
      "into a dead channel is indistinguishable from one that works until a real incident fires.\n" +
      "This check deliberately fails rather than passes when no human has confirmed receipt.\n",
  );
  process.stdout.write(JSON.stringify({ acked: false, reason: result.reason }) + "\n");
  process.exit(1);
}

process.stdout.write(
  JSON.stringify({ acked: true, ackedAt: result.ackedAt, nonce: result.nonce }) + "\n",
);
process.exit(0);
