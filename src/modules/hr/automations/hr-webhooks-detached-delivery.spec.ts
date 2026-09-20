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
