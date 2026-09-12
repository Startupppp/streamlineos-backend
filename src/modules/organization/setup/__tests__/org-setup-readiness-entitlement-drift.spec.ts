import { subscriptionStatusEnum } from "../../../../db/schema";
import { READY_ENTITLEMENT_STATUSES } from "../org-setup-internals";

const BILLING_TERMINAL_STATUSES = ["CANCELLED", "EXPIRED"] as const;
const ACCEPTED_DIVERGENCE = ["SUSPENDED"] as const;

const isReady = (status: string) => READY_ENTITLEMENT_STATUSES.some((s) => s === status);
const isBillingTerminal = (status: string) => BILLING_TERMINAL_STATUSES.some((s) => s === status);

describe("readiness entitlement allowlist versus the billing tier rule", () => {
  const allStatuses = subscriptionStatusEnum.enumValues;

  it("never admits a status billing treats as terminal", () => {
    const wrongly = READY_ENTITLEMENT_STATUSES.filter((s) => isBillingTerminal(s));
    expect(wrongly).toEqual([]);
  });

  it("pins every status where readiness is stricter than the billing tier rule", () => {
    const billingEntitled = allStatuses.filter((s) => !isBillingTerminal(s));
    const stricter = billingEntitled.filter((s) => !isReady(s));
    expect(stricter).toEqual([...ACCEPTED_DIVERGENCE]);
  });

  it("denies every status outside the allowlist, so a new enum member fails closed", () => {
    const denied = allStatuses.filter((s) => !isReady(s));
    expect(denied.sort()).toEqual(["CANCELLED", "EXPIRED", "SUSPENDED"]);
  });

  it("admits exactly the three non-terminal, non-suspended statuses", () => {
    expect([...READY_ENTITLEMENT_STATUSES].sort()).toEqual(["ACTIVE", "PAST_DUE", "TRIAL"]);
  });
});
