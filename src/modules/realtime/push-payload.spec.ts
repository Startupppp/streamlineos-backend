import { pushPayloadSchema } from "./dto/realtime.schemas";

/**
 * RT-001 regression guard. Web push payloads transit a third-party push service
 * and render on lock screens and in OS notification history, so they must carry an
 * identifier and a generic category — never record content.
 *
 * The brief requires this asserted on the payload rather than the UI, because the
 * UI is not where the leak happens.
 */
describe("push payload", () => {
  const ALLOWED_KEYS = ["category", "url", "notificationId", "idempotencyKey"];

  it("exposes only the allowed keys", () => {
    expect(Object.keys(pushPayloadSchema.shape).sort()).toEqual([...ALLOWED_KEYS].sort());
  });

  it("has no free-text content field", () => {
    const forbidden = ["title", "body", "message", "content", "subject", "name", "preview"];
    const present = forbidden.filter((k) => k in pushPayloadSchema.shape);
    expect(present).toEqual([]);
  });

  it("strips content a caller tries to smuggle through", () => {
    const parsed = pushPayloadSchema.parse({
      category: "PAYROLL",
      url: "/notifications",
      notificationId: 12,
      body: "Net pay ₹120000",
      title: "Your payslip",
    });
    expect(parsed).toEqual({ category: "PAYROLL", url: "/notifications", notificationId: 12 });
    expect(JSON.stringify(parsed)).not.toContain("120000");
    expect(JSON.stringify(parsed)).not.toContain("payslip");
  });

  it("rejects a category outside the enum, so it cannot become a free-text channel", () => {
    expect(() => pushPayloadSchema.parse({ category: "Net pay ₹120000" })).toThrow();
  });

  it("accepts a payload carrying only a url", () => {
    expect(pushPayloadSchema.parse({ url: "/notifications" })).toEqual({ url: "/notifications" });
  });
});
