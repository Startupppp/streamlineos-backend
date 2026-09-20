/**
 * `testSubscription` and `redeliver` fire their HTTP delivery without awaiting
 * it, so the handler returns and `TenantContextInterceptor` commits the request
 * transaction while `fetch` is still in flight.
 *
 * The continuation then ran `this.db.update(hrWebhookDeliveries)`. `this.db` is
 * the tenant-aware proxy (`common/tenant/tenant-db.ts:16`), and the async-local
 * context survives into the continuation — so that update resolved onto the
 * request's `tx` object after its transaction had committed and its connection
 * had gone back to the pool. `hr_webhook_deliveries` carries no RLS policy, so
 * this never produced the `42501` that makes the same mistake loud elsewhere:
 * it either threw into a `void`, or issued a statement on a pooled connection
 * another request had since borrowed.
 *
 * Either way the delivery row was never stamped, so a webhook that really was
 * delivered sat at `pending` until the retry sweep sent it a second time.
 *
 * The fix is the pattern `webhooks-dispatch.service.ts:61-66` already
 * documents: leave the tenant context before detaching, and let the status
 * write open a transaction of its own once the round trip is done.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "hr-webhooks.service.ts"), "utf8");

function bodyOf(method: string): string {
  const start = SOURCE.indexOf(`async ${method}(`);
  if (start === -1) throw new Error(`${method} not found`);
  const next = SOURCE.indexOf("\n  async ", start + 1);
  return SOURCE.slice(start, next === -1 ? SOURCE.length : next);
}

describe("an HR webhook delivery detached from the request", () => {
  it("finds the handlers it is checking, so the scans below are not passing over nothing", () => {
    expect(bodyOf("testSubscription").length).toBeGreaterThan(100);
    expect(bodyOf("redeliver").length).toBeGreaterThan(100);
  });

  it("never fires attemptDelivery straight off the request, because its tx commits mid-flight", () => {
    expect(SOURCE).not.toContain("void this.attemptDelivery(");
  });

  it("leaves the tenant context first, so the continuation cannot inherit a committed transaction", () => {
    expect(SOURCE).toContain("runOutsideTenantContext(() =>");
  });

  it("routes both interactive actions through the detaching seam rather than their own copy", () => {
    expect(bodyOf("testSubscription")).toContain("this.detachDelivery(");
    expect(bodyOf("redeliver")).toContain("this.detachDelivery(");
  });

  it("stamps the delivery in a transaction it opens itself, since the request's is gone by then", () => {
    const from = SOURCE.indexOf("private async attemptDelivery(");
    const attempt = SOURCE.slice(from, SOURCE.indexOf("\n  async ", from));
    const statusWrites = attempt.split("update(hrWebhookDeliveries)").length - 1;
    expect(statusWrites).toBe(2);
    expect(attempt.split("runInNewTenantTransaction(this.db, orgId").length - 1).toBe(2);
  });

  it("ANTI-VACUITY: the banned pattern is one the scan would really catch", () => {
    expect("void this.attemptDelivery(a, b);").toContain("void this.attemptDelivery(");
  });
});
