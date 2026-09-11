import { createHash } from "node:crypto";

/** The exact precedence that shipped at journal head, kept so the net proves it bites. */
export function headResolveProviderEventId(
  header: string | undefined,
  normalized: { providerEventId?: string },
  rawBody: string,
): { ok: true; id: string } | { ok: false } {
  const supplied = header?.trim();
  if (supplied && normalized.providerEventId && supplied !== normalized.providerEventId) {
    return { ok: false };
  }
  return {
    ok: true,
    id: supplied || normalized.providerEventId || createHash("sha256").update(rawBody).digest("hex"),
  };
}

/** One captured, correctly-signed Razorpay-shaped body. No top-level `id`, as Razorpay sends. */
export const SIGNED_BODY = JSON.stringify({
  event: "payment.captured",
  payload: {
    payment: {
      entity: { id: "pay_replay_001", amount: 49900, currency: "INR", status: "captured" },
    },
  },
});
