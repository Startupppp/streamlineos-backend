import { mint, req, check, report } from "./harness.mjs";

// ───────────────────────────────────────────────────────────────────────────
// Gap: GET /billing/razorpay — src/modules/billing
//   JwtAuthGuard + AbilityGuard (NO @CheckAbility → auth-only)
//   → BillingService.getSubscription(orgId)
//   Mirrors the frontend GET app/api/billing/razorpay/route.ts response:
//     { subscription: <subscriptions row + recent payments | null>, razorpayKeyId, isConfigured }
// SAFETY: read-only GET — no orders, subscriptions, or payments are created.
// ───────────────────────────────────────────────────────────────────────────

const owner = await mint("owner");
const member = await mint("member");

check("no-token GET /billing/razorpay -> 401", await req("GET", "/billing/razorpay", {}), 401);

const sub = await req("GET", "/billing/razorpay", { token: owner });
check("owner GET /billing/razorpay -> 200", sub, 200);

const shapeOk =
  sub.status === 200 &&
  sub.body !== null &&
  typeof sub.body === "object" &&
  "subscription" in sub.body &&
  "isConfigured" in sub.body &&
  typeof sub.body.isConfigured === "boolean" &&
  "razorpayKeyId" in sub.body &&
  (sub.body.subscription === null || typeof sub.body.subscription === "object");
check("GET /billing/razorpay response shape {subscription,isConfigured,razorpayKeyId}", { status: shapeOk ? 200 : 500 }, 200);

check("member GET /billing/razorpay -> 200 (auth-only, not over-gated)", await req("GET", "/billing/razorpay", { token: member }), 200);

process.exit(report("gap-billing") ? 0 : 1);
