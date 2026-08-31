import { computeAuditRowHash, stableStringify } from "./timesheets-audit.service";

describe("stableStringify", () => {
  it("is key-order independent", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("serializes dates like JSON.stringify (ISO strings)", () => {
    const d = new Date("2026-07-25T10:00:00.000Z");
    expect(stableStringify({ at: d })).toBe('{"at":"2026-07-25T10:00:00.000Z"}');
  });

  it("handles arrays, nulls, and primitives", () => {
    expect(stableStringify([1, "x", null, { b: 2, a: 1 }])).toBe('[1,"x",null,{"a":1,"b":2}]');
  });
});

describe("computeAuditRowHash", () => {
  const params = {
    orgId: "org-1",
    actorMembershipId: 1,
    entityType: "entry",
    entityId: "42",
    action: "entry.created",
    after: { hours: 8, date: "2026-07-20" },
  };

  it("is deterministic", () => {
    expect(computeAuditRowHash(null, params)).toBe(computeAuditRowHash(null, params));
  });

  it("changes when the previous hash changes (chain link)", () => {
    expect(computeAuditRowHash(null, params)).not.toBe(computeAuditRowHash("abc", params));
  });

  it("changes when the payload changes (tamper evidence)", () => {
    const tampered = { ...params, after: { hours: 80, date: "2026-07-20" } };
    expect(computeAuditRowHash(null, params)).not.toBe(computeAuditRowHash(null, tampered));
  });

  it("survives jsonb key reordering of before/after", () => {
    const reordered = { ...params, after: { date: "2026-07-20", hours: 8 } };
    expect(computeAuditRowHash(null, params)).toBe(computeAuditRowHash(null, reordered));
  });
});
