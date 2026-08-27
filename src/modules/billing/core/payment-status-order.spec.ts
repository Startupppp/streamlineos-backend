import { PgDialect } from "drizzle-orm/pg-core";
import { platformPayments } from "../../../db/schema";
import {
  forwardOnlyStatusGuard,
  isForwardPaymentTransition,
  paymentStatusRank,
  UNKNOWN_PAYMENT_STATUS_RANK,
} from "./payment-status-order";

const dialect = new PgDialect();

// A captured drizzle condition is circular; render it to SQL rather than stringifying it.
function render(status: string): string {
  return dialect.sqlToQuery(forwardOnlyStatusGuard(platformPayments.status, status)).sql;
}

describe("payment lifecycle ordering", () => {
  it("ranks the provider lifecycle in the order money actually moves", () => {
    expect(paymentStatusRank("created")).toBeLessThan(paymentStatusRank("authorized"));
    expect(paymentStatusRank("authorized")).toBeLessThan(paymentStatusRank("captured"));
    expect(paymentStatusRank("captured")).toBeLessThan(paymentStatusRank("refunded"));
  });

  it("ranks an unrecognised status below every known one so it can never clobber a known state", () => {
    expect(paymentStatusRank("something-new")).toBe(UNKNOWN_PAYMENT_STATUS_RANK);
    expect(isForwardPaymentTransition("captured", "something-new")).toBe(false);
    expect(isForwardPaymentTransition("something-new", "captured")).toBe(true);
  });

  describe("out-of-order arrival does not corrupt state", () => {
    it("refuses a redelivered authorized event over a captured payment", () => {
      expect(isForwardPaymentTransition("captured", "authorized")).toBe(false);
    });

    it("refuses a failed event over a captured payment", () => {
      expect(isForwardPaymentTransition("captured", "failed")).toBe(false);
    });

    it("refuses a captured event over a refunded payment", () => {
      expect(isForwardPaymentTransition("refunded", "captured")).toBe(false);
    });

    it("accepts the forward transitions", () => {
      expect(isForwardPaymentTransition("authorized", "captured")).toBe(true);
      expect(isForwardPaymentTransition("captured", "refunded")).toBe(true);
      expect(isForwardPaymentTransition("created", "authorized")).toBe(true);
    });

    it("accepts a redelivery of the same status, so a plain replay stays idempotent", () => {
      expect(isForwardPaymentTransition("captured", "captured")).toBe(true);
    });
  });

  describe("the guard reaches the statement", () => {
    it("compares the stored status rank against the incoming one", () => {
      const sql = render("captured");
      expect(sql).toContain("case when");
      expect(sql).toContain('"platform_payments"."status"');
      expect(sql.trimEnd().endsWith("<= 3")).toBe(true);
    });

    it("binds an incoming refund above a capture, and an unknown status below everything", () => {
      expect(render("refunded").trimEnd().endsWith("<= 4")).toBe(true);
      expect(render("who-knows").trimEnd().endsWith("<= -1")).toBe(true);
    });

    it("never interpolates the status text as a literal — statuses stay bound parameters", () => {
      expect(render("captured")).not.toContain("'captured'");
    });
  });
});
