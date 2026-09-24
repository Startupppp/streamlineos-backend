import {
  BGV_STATUSES,
  canTransition,
  decideVerdict,
  describeBgv,
  isAgencyClearance,
  TERMINAL_BGV_STATUSES,
  type BgvStatus,
} from "./bgv-status";
import { BGV_ADAPTERS, resolveBgv } from "./bgv-provider";

describe("canTransition", () => {
  it("starts a check from nothing", () => {
    expect(canTransition("NOT_INITIATED", "INITIATED")).toBe(true);
  });

  it("does not skip straight to a verdict from nothing", () => {
    expect(canTransition("NOT_INITIATED", "CLEARED")).toBe(false);
    expect(canTransition("NOT_INITIATED", "FAILED")).toBe(false);
    expect(canTransition("NOT_INITIATED", "PENDING")).toBe(false);
  });

  /**
   * The one that matters: a cleared check cannot quietly become a failed one.
   * "We changed our mind" and "we ran it again and got a different answer" are
   * different events, and only the second is defensible.
   */
  it("refuses to flip a verdict without re-opening the check", () => {
    expect(canTransition("CLEARED", "FAILED")).toBe(false);
    expect(canTransition("FAILED", "CLEARED")).toBe(false);
  });

  it("allows a finished check to be re-run", () => {
    expect(canTransition("CLEARED", "INITIATED")).toBe(true);
    expect(canTransition("FAILED", "INITIATED")).toBe(true);
  });

  it("treats a repeat of the same status as allowed", () => {
    for (const status of BGV_STATUSES) expect(canTransition(status, status)).toBe(true);
  });

  it("names exactly the two finished statuses as terminal", () => {
    expect([...TERMINAL_BGV_STATUSES].sort()).toEqual(["CLEARED", "FAILED"]);
  });
});

describe("decideVerdict", () => {
  it("accepts a recruiter recording a check they ran themselves", () => {
    expect(
      decideVerdict({ from: "INITIATED", to: "CLEARED", source: "MANUAL", reference: null }),
    ).toEqual({ ok: true });
  });

  /**
   * An agency verdict with no case reference is indistinguishable from a forged
   * one — and the offer policy that trusts agency verdicts is exactly why
   * somebody would forge it.
   */
  it("refuses an agency verdict with no case reference", () => {
    const decision = decideVerdict({
      from: "INITIATED",
      to: "CLEARED",
      source: "AGENCY",
      reference: null,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("expected a refusal");
    expect(decision.reason).toContain("case reference");
  });

  it("accepts an agency verdict that carries one", () => {
    expect(
      decideVerdict({ from: "PENDING", to: "CLEARED", source: "AGENCY", reference: "AB-991" }),
    ).toEqual({ ok: true });
  });

  it("refuses an illegal transition whatever the source", () => {
    for (const source of ["MANUAL", "AGENCY"] as const) {
      const decision = decideVerdict({
        from: "CLEARED",
        to: "FAILED",
        source,
        reference: "AB-991",
      });
      expect(decision.ok).toBe(false);
    }
  });
});

describe("isAgencyClearance", () => {
  /**
   * The whole reason `bgv_source` exists. An offer policy that requires a
   * verified background check must not be satisfied by somebody ticking a box.
   */
  it("is true only for a CLEARED an agency returned", () => {
    expect(isAgencyClearance("CLEARED", "AGENCY")).toBe(true);
    expect(isAgencyClearance("CLEARED", "MANUAL")).toBe(false);
    expect(isAgencyClearance("CLEARED", null)).toBe(false);
  });

  it("is false for every non-cleared status, whatever the source", () => {
    const statuses: BgvStatus[] = ["NOT_INITIATED", "INITIATED", "PENDING", "FAILED"];
    for (const status of statuses) {
      expect(isAgencyClearance(status, "AGENCY")).toBe(false);
      expect(isAgencyClearance(status, "MANUAL")).toBe(false);
    }
  });
});

describe("describeBgv", () => {
  it("says plainly when a clearance had no agency behind it", () => {
    expect(describeBgv("CLEARED", "MANUAL")).toContain("no agency verified this");
  });

  it("says plainly when one did", () => {
    expect(describeBgv("CLEARED", "AGENCY")).toBe("Cleared by the verification agency.");
  });

  it("has a sentence for every status", () => {
    for (const status of BGV_STATUSES) {
      expect(describeBgv(status, null).length).toBeGreaterThan(5);
      expect(describeBgv(status, "AGENCY").endsWith(".")).toBe(true);
    }
  });
});

describe("the BGV provider", () => {
  /**
   * `CLEARED` is what an offer gets released against. An adapter that answered
   * "cleared" with no agency behind it would be the exact failure the brief
   * names, and unlike a missing job-board post nobody would ever notice —
   * a clearance looks the same whether or not anybody checked.
   */
  it("ships no adapter", () => {
    expect(BGV_ADAPTERS.size).toBe(0);
  });

  it("blocks with no-integration when no agency is connected", () => {
    expect(resolveBgv(null)).toMatchObject({ status: "BLOCKED", code: "no-integration" });
  });

  it("blocks as not-implemented with credentials saved, and names the manual route", () => {
    const resolved = resolveBgv({
      platform: "BACKGROUND_CHECK",
      isActive: true,
      token: "agency-key",
      meta: {},
    });
    expect(resolved).toMatchObject({ status: "BLOCKED", code: "not-implemented" });
    if ("adapter" in resolved) throw new Error("expected no adapter");
    expect(resolved.message).toContain("record the outcome here");
  });

  it("blocks as needs-keys when connected and active with no token", () => {
    expect(
      resolveBgv({ platform: "BACKGROUND_CHECK", isActive: true, token: null, meta: {} }),
    ).toMatchObject({ status: "BLOCKED", code: "needs-keys" });
  });
});
