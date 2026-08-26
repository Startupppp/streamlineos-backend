/**
 * Detects inbound webhook signature verification failures.
 *
 * Two sources, one for each webhook surface:
 *
 * 1. PAYMENT WEBHOOKS (database-backed — primary, most reliable).
 *    payment_webhook_endpoints.status = 'failing' means a provider posted a webhook
 *    whose HMAC did not match the configured secret. Cause: secret rotated on the
 *    provider side without updating Settings > Payments, OR a replay/forgery attempt.
 *
 * 2. GIT INTEGRATION WEBHOOKS (structured-log only — no DB state is stored).
 *    The git integration logs level=warn with message "[git-webhook] signature
 *    verification failed" when GitHub/GitLab sends a webhook whose X-Hub-Signature-256
 *    doesn't match the connection secret. These events do NOT write to a table, so they
 *    cannot be detected by a DB query alone. To monitor them, pipe the application's
 *    stderr through a log aggregator and alert on:
 *
 *      jq 'select(.level == "warn" and (.message | contains("signature verification failed")))' \
 *        app.log
 *
 *    or in your log analytics platform: level=warn AND message:"signature verification failed"
 *    Recommended threshold: > 5 occurrences in 1 hour (single misconfigured hook can repeat).
 *
 * This script handles source 1 (DB) and exits 1 when the predicate fires.
 * Source 2 must be configured separately in your log aggregator.
 *
 * Usage: node alert-sig-failures.mjs [--hours=N] [--self-test]
 * Env:   DATABASE_URL (owner/migration role — BYPASSRLS, no tenant GUC needed)
 */
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "24", 10));
const THRESHOLD = 0;

function predicate(rows) {
  return rows.length > THRESHOLD;
}

if (args.includes("--self-test")) {
  const now = Date.now();
  const withinWindow = [
    {
      org_id: "org_fixture_1",
      provider_key: "razorpay",
      environment: "live",
      status: "failing",
      last_failure_at: new Date(now - 120_000).toISOString(),
      failure_reason: "Invalid signature",
    },
  ];
  const outsideWindow = [
    {
      org_id: "org_fixture_1",
      provider_key: "razorpay",
      environment: "live",
      status: "failing",
      last_failure_at: new Date(now - (hours + 1) * 3_600_000).toISOString(),
      failure_reason: "Invalid signature",
    },
  ];
  const windowMs = hours * 3_600_000;
  const case1Rows = withinWindow.filter((r) => now - new Date(r.last_failure_at).getTime() < windowMs);
  const case2Rows = outsideWindow.filter((r) => now - new Date(r.last_failure_at).getTime() < windowMs);
  const case1 = predicate(case1Rows);
  const case2 = predicate(case2Rows);
  const pass = case1 === true && case2 === false;
  process.stdout.write(
    JSON.stringify({
      selfTest: true,
      pass,
      case1FiresOnFailingEndpoint: case1,
      case2ClearsOnStaleFailure: !case2,
      note: "git-webhook signature failures are log-only — configure your log aggregator separately",
    }) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required (owner/migration role — BYPASSRLS, no tenant GUC needed)\n");
  process.exit(2);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
try {
  const rows = await sql`
    SELECT
      pwe.org_id,
      pp.provider_key,
      pwe.environment,
      pwe.status,
      pwe.last_failure_at,
      pwe.failure_reason
    FROM payment_webhook_endpoints pwe
    JOIN payment_providers pp ON pp.id = pwe.provider_id
    WHERE pwe.status = 'failing'
      AND pwe.last_failure_at > NOW() - (${hours} * INTERVAL '1 hour')
    ORDER BY pwe.last_failure_at DESC
  `;
  const fired = predicate(rows);
  process.stdout.write(
    JSON.stringify({
      fired,
      count: rows.length,
      threshold: { maxFailingEndpointsInWindow: THRESHOLD, windowHours: hours },
      destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system",
      rows,
      note: "git-webhook signature failures are level=warn in structured logs — configure log aggregator separately",
    }) + "\n",
  );
  process.exit(fired ? 1 : 0);
} finally {
  await sql.end();
}
