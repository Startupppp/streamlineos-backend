import { createHmac } from "node:crypto";
import { BASE_URL, mint, req, check, report } from "./harness.mjs";

// ───────────────────────────────────────────────────────────────────────────
// Billing integration (Razorpay) — src/modules/billing
// Routes (method · path · guard):
//   GET   /billing            JwtAuthGuard + AbilityGuard (NO @CheckAbility → auth-only)
//   POST  /billing/razorpay   JwtAuthGuard + AbilityGuard @CheckAbility(manage,settings)  [HttpCode 200] → createOrder (REAL Razorpay call when configured)
//   PATCH /billing/razorpay   JwtAuthGuard + AbilityGuard @CheckAbility(manage,settings)        → verifyAndActivate (local HMAC + DB write)
//   POST  /webhooks/razorpay  @Public — raw body + x-razorpay-signature HMAC verification
//
// SAFETY: This .env has RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET EMPTY (only the
// webhook secret is set), so isConfigured()===false and POST/PATCH short-circuit
// to a 503 "not configured" BEFORE any fetch to api.razorpay.com — no real order
// is ever created. As a hard guard, the valid-plan POST/PATCH are still gated on
// GET /billing reporting isConfigured:false so we NEVER trigger a paid call even
// if keys appear. No subscriptions/orders are created; webhook tests use a signed
// no-payload event so nothing is persisted.
// ───────────────────────────────────────────────────────────────────────────

const owner = await mint("owner");            // isOrgOwner → manage:all
const member = await mint("member");          // no perms
const sales = await mint("salesRep");         // wrong role (no manage:settings)
const hr = await mint("hrManager");           // wrong role (no manage:settings)

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

// Raw POST to the public webhook with an explicit signature header. The server
// HMACs req.rawBody (rawBody:true in main.ts), so we must sign the EXACT bytes.
async function webhookPost(rawString, signature) {
  const headers = { "Content-Type": "application/json" };
  if (signature !== undefined) headers["x-razorpay-signature"] = signature;
  const res = await fetch(`${BASE_URL}/webhooks/razorpay`, {
    method: "POST",
    headers,
    body: rawString,
  });
  let parsed = null;
  const text = await res.text();
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const sign = (raw) => createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");

// ───────────────────────────────────────────────────────────────────────────
// 1) AUTH — protected routes with no token → 401
// ───────────────────────────────────────────────────────────────────────────
check("no-token GET /billing -> 401", await req("GET", "/billing", {}), 401);
check("no-token POST /billing/razorpay -> 401", await req("POST", "/billing/razorpay", { body: { plan: "STARTER" } }), 401);
check("no-token PATCH /billing/razorpay -> 401", await req("PATCH", "/billing/razorpay", { body: { razorpay_order_id: "o", razorpay_payment_id: "p", razorpay_signature: "s", plan: "STARTER" } }), 401);

// ───────────────────────────────────────────────────────────────────────────
// 2) GET /billing — owner 200 read (the safe real call: assert response shape)
// ───────────────────────────────────────────────────────────────────────────
const sub = await req("GET", "/billing", { token: owner });
check("owner GET /billing -> 200", sub, 200);
const shapeOk =
  sub.status === 200 &&
  sub.body !== null &&
  typeof sub.body === "object" &&
  "subscription" in sub.body &&
  "isConfigured" in sub.body &&
  typeof sub.body.isConfigured === "boolean" &&
  "razorpayKeyId" in sub.body &&
  (sub.body.subscription === null || typeof sub.body.subscription === "object");
check("GET /billing response shape {subscription,isConfigured,razorpayKeyId}", { status: shapeOk ? 200 : 500 }, 200);

const isConfigured = sub.body?.isConfigured === true;
console.log(`  [info] razorpay isConfigured=${isConfigured} razorpayKeyId=${JSON.stringify(sub.body?.razorpayKeyId)}`);

// GET /billing has NO @CheckAbility → auth-only; a no-perms member must NOT be over-gated
check("member GET /billing -> 200 (auth-only, not over-gated)", await req("GET", "/billing", { token: member }), 200);

// ───────────────────────────────────────────────────────────────────────────
// 3) POST /billing/razorpay — RBAC + input validation + not-configured path
// ───────────────────────────────────────────────────────────────────────────
// RBAC-negative: non-owner / wrong-role lack manage:settings → 403
check("member POST /billing/razorpay -> 403 (no manage:settings)", await req("POST", "/billing/razorpay", { token: member, body: { plan: "STARTER" } }), 403);
check("salesRep POST /billing/razorpay -> 403 (wrong role)", await req("POST", "/billing/razorpay", { token: sales, body: { plan: "STARTER" } }), 403);
check("hrManager POST /billing/razorpay -> 403 (wrong role)", await req("POST", "/billing/razorpay", { token: hr, body: { plan: "STARTER" } }), 403);

// Input validation (owner passes RBAC, then ZodValidationPipe rejects → 400, no external call)
check("owner POST /billing/razorpay {} -> 400 (missing plan)", await req("POST", "/billing/razorpay", { token: owner, body: {} }), 400);
check("owner POST /billing/razorpay invalid plan -> 400", await req("POST", "/billing/razorpay", { token: owner, body: { plan: "FREE" } }), 400);
check("owner POST /billing/razorpay lowercase plan -> 400", await req("POST", "/billing/razorpay", { token: owner, body: { plan: "starter" } }), 400);

// Graceful not-configured path (keys empty → 503 BEFORE fetch). Hard-gated on
// isConfigured:false so we never trigger a paid order even if keys appear.
if (!isConfigured) {
  const r = await req("POST", "/billing/razorpay", { token: owner, body: { plan: "STARTER" } });
  check("owner POST /billing/razorpay (valid plan, keys empty) -> 503 not-configured", r, 503);
  const msgOk = typeof r.body?.error === "string" && /configur/i.test(r.body.error);
  check("POST not-configured 503 carries a 'not configured' message", { status: msgOk ? 200 : 500 }, 200);
} else {
  console.log("  [skip] isConfigured=true → skipping valid-plan POST to avoid a REAL Razorpay order");
}

// ───────────────────────────────────────────────────────────────────────────
// 4) PATCH /billing/razorpay — RBAC + input validation + verify path
// ───────────────────────────────────────────────────────────────────────────
const validVerifyBody = { razorpay_order_id: "order_FAKE", razorpay_payment_id: "pay_FAKE", razorpay_signature: "deadbeef", plan: "STARTER" };
check("member PATCH /billing/razorpay -> 403 (no manage:settings)", await req("PATCH", "/billing/razorpay", { token: member, body: validVerifyBody }), 403);
check("salesRep PATCH /billing/razorpay -> 403 (wrong role)", await req("PATCH", "/billing/razorpay", { token: sales, body: validVerifyBody }), 403);

// Input validation (owner passes RBAC; Zod rejects malformed body → 400)
check("owner PATCH /billing/razorpay {} -> 400 (missing fields)", await req("PATCH", "/billing/razorpay", { token: owner, body: {} }), 400);
check("owner PATCH /billing/razorpay missing signature -> 400", await req("PATCH", "/billing/razorpay", { token: owner, body: { razorpay_order_id: "o", razorpay_payment_id: "p", plan: "STARTER" } }), 400);
check("owner PATCH /billing/razorpay invalid plan -> 400", await req("PATCH", "/billing/razorpay", { token: owner, body: { ...validVerifyBody, plan: "FREE" } }), 400);

// Owner valid-shape body with a BOGUS signature. Keys empty → 503 not-configured.
// If keys were present it would be 400 "invalid signature" (signature check precedes
// any DB write, so still no subscription is activated). Accept both graceful paths.
{
  const r = await req("PATCH", "/billing/razorpay", { token: owner, body: validVerifyBody });
  check("owner PATCH /billing/razorpay (bogus sig) -> 503 not-configured | 400 invalid-sig (no mutation)", r, [400, 503]);
}

// ───────────────────────────────────────────────────────────────────────────
// 5) POST /webhooks/razorpay — public, HMAC signature verification
// ───────────────────────────────────────────────────────────────────────────
const goodEvent = JSON.stringify({ event: "payment.authorized", payload: {} }); // no payment.entity → ack & ignore, no DB write

// Unsigned → rejected 401
check("webhook no signature -> 401 rejected", await webhookPost(goodEvent, undefined), 401);
// Badly signed → rejected 401
check("webhook bad signature -> 401 rejected", await webhookPost(goodEvent, "not-a-valid-signature"), 401);
// Correct signature over wrong bytes (replay/tamper) → 401
check("webhook valid-format sig over different body -> 401 rejected", await webhookPost(goodEvent, sign('{"event":"other","payload":{}}')), 401);

if (WEBHOOK_SECRET) {
  // Correctly HMAC-signed, schema-valid, no payment entity → 200 acked & ignored (no persistence)
  const acc = await webhookPost(goodEvent, sign(goodEvent));
  check("webhook correctly signed (no payment) -> 200 acked", acc, 200);
  const ackOk = acc.body?.ok === true;
  check("webhook 200 body { ok:true } (ignored event, nothing persisted)", { status: ackOk ? 200 : 500 }, 200);

  // Correctly signed but schema-INVALID payload → 400 invalid payload (HMAC passed, validation rejected)
  const badPayload = JSON.stringify({ notevent: true });
  const inv = await webhookPost(badPayload, sign(badPayload));
  check("webhook signed + invalid payload -> 400 rejected by schema", inv, 400);
} else {
  console.log("  [skip] RAZORPAY_WEBHOOK_SECRET not set → cannot exercise the signed-accept path");
}

process.exit(report("int-billing") ? 0 : 1);
