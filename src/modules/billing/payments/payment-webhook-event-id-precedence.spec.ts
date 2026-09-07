import { createHash } from "node:crypto";
import { resolveProviderEventId } from "./payment-webhook-receiver.service";
import { headResolveProviderEventId, SIGNED_BODY } from "./payment-webhook-event-id-precedence-fixtures";

const BODY_DIGEST = createHash("sha256").update(SIGNED_BODY).digest("hex");

describe("webhook event id precedence — hermetic", () => {
  it("an unsigned header never becomes the key when the signed envelope carries no id", () => {
    // The vulnerable branch, and the ordinary Razorpay branch.
    const resolved = resolveProviderEventId("attacker-chosen-1", {}, SIGNED_BODY);
    expect(resolved).toEqual({ ok: true, id: BODY_DIGEST });
    expect(resolved).not.toEqual({ ok: true, id: "attacker-chosen-1" });
  });

  it("N different headers over ONE signed body collapse to ONE key", () => {
    const keys = new Set(
      Array.from({ length: 25 }, (_, i) => resolveProviderEventId(`forged-${i}`, {}, SIGNED_BODY)).map(
        (r) => (r.ok ? r.id : "rejected"),
      ),
    );
    expect(keys).toEqual(new Set([BODY_DIGEST]));
  });

  it("the head form is what produced N keys — this is the defect, stated", () => {
    const keys = new Set(
      Array.from({ length: 25 }, (_, i) => headResolveProviderEventId(`forged-${i}`, {}, SIGNED_BODY)).map(
        (r) => (r.ok ? r.id : "rejected"),
      ),
    );
    expect(keys.size).toBe(25);
  });

  it("a signed envelope id still wins over the body digest", () => {
    expect(resolveProviderEventId(undefined, { providerEventId: "evt_signed" }, SIGNED_BODY)).toEqual({
      ok: true,
      id: "evt_signed",
    });
  });

  it("an agreeing header changes nothing", () => {
    expect(resolveProviderEventId("evt_signed", { providerEventId: "evt_signed" }, SIGNED_BODY)).toEqual({
      ok: true,
      id: "evt_signed",
    });
  });

  it("a disagreeing header is still a 400, not a silently ignored one", () => {
    expect(resolveProviderEventId("header-id", { providerEventId: "body-id" }, "{}")).toEqual({ ok: false });
  });

  it("an empty signed id falls through to the digest rather than collapsing every event onto ''", () => {
    expect(resolveProviderEventId(undefined, { providerEventId: "   " }, SIGNED_BODY)).toEqual({
      ok: true,
      id: BODY_DIGEST,
    });
  });

  it("the digest is stable across calls, so a genuine provider retry still dedupes", () => {
    expect(resolveProviderEventId(undefined, {}, SIGNED_BODY)).toEqual(
      resolveProviderEventId("some-header", {}, SIGNED_BODY),
    );
  });
});
