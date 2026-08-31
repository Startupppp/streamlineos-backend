import { fingerprintOf } from "./error-fingerprint";

function errorFrom(message: string, frame: string): Error {
  const error = new Error(message);
  error.stack = [`Error: ${message}`, `    at ${frame}`].join("\n");
  return error;
}

describe("fingerprintOf", () => {
  it("groups the same failure across occurrences that differ only by identifier", () => {
    const first = errorFrom(
      "permission denied for row 8f14e45f-ceea-467a-9a3f-000000000000",
      "NotificationService.deliver (/app/src/modules/notifications/x.ts:10:5)",
    );
    const second = errorFrom(
      "permission denied for row 1a2b3c4d-5e6f-4a7b-8c9d-111111111111",
      "NotificationService.deliver (/app/src/modules/notifications/x.ts:10:5)",
    );

    expect(fingerprintOf(first)).toBe(fingerprintOf(second));
  });

  it("groups occurrences that differ only by a quantity or a quoted value", () => {
    const frame = "BillingService.charge (/app/src/modules/billing/x.ts:22:9)";
    expect(fingerprintOf(errorFrom("only 3 seats remain", frame))).toBe(
      fingerprintOf(errorFrom("only 41 seats remain", frame)),
    );
    expect(fingerprintOf(errorFrom(`duplicate key "ada@example.com"`, frame))).toBe(
      fingerprintOf(errorFrom(`duplicate key "grace@example.com"`, frame)),
    );
  });

  it("separates two different failures raised from the same place", () => {
    const frame = "DealsService.find (/app/src/modules/crm/deals.service.ts:44:11)";
    expect(fingerprintOf(errorFrom("permission denied", frame))).not.toBe(
      fingerprintOf(errorFrom("relation does not exist", frame)),
    );
  });

  it("separates the same message raised from different places", () => {
    expect(
      fingerprintOf(errorFrom("not found", "A.get (/app/src/modules/a/a.service.ts:1:1)")),
    ).not.toBe(fingerprintOf(errorFrom("not found", "B.get (/app/src/modules/b/b.service.ts:1:1)")));
  });

  it("separates the same failure on different routes", () => {
    const error = errorFrom("boom", "X.y (/app/src/modules/x/x.service.ts:1:1)");
    expect(fingerprintOf(error, "/deals")).not.toBe(fingerprintOf(error, "/invoices"));
  });

  it("skips node_modules and node internal frames when choosing the origin", () => {
    const withNoise = new Error("boom");
    withNoise.stack = [
      "Error: boom",
      "    at Object.get (/app/node_modules/drizzle-orm/index.js:9:9)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "    at DealsService.find (/app/src/modules/crm/deals.service.ts:44:11)",
    ].join("\n");

    const withoutNoise = errorFrom(
      "boom",
      "DealsService.find (/app/src/modules/crm/deals.service.ts:44:11)",
    );

    expect(fingerprintOf(withNoise)).toBe(fingerprintOf(withoutNoise));
  });

  it("is stable for the same error object across calls", () => {
    const error = errorFrom("boom", "X.y (/app/src/modules/x/x.service.ts:1:1)");
    expect(fingerprintOf(error)).toBe(fingerprintOf(error));
  });

  it("fingerprints a thrown non-error without throwing", () => {
    expect(typeof fingerprintOf("just a string")).toBe("string");
    expect(fingerprintOf("just a string")).toHaveLength(12);
  });
});
