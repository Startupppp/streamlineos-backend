import { redact } from "./redact";

describe("redact", () => {
  it("leaves ordinary values untouched", () => {
    expect(redact({ orgId: "org-1", count: 3, ok: true })).toEqual({
      orgId: "org-1",
      count: 3,
      ok: true,
    });
  });

  it("redacts credential-bearing keys regardless of casing", () => {
    const out = redact({
      password: "hunter2",
      accessToken: "abc",
      Authorization: "Bearer x",
      API_KEY: "k",
      refreshToken: "r",
      cookie: "session=1",
    }) as Record<string, unknown>;

    for (const value of Object.values(out)) {
      expect(value).toBe("[redacted]");
    }
  });

  it("redacts personal identifiers", () => {
    const out = redact({ ssn: "1", panNumber: "2", aadhaar: "3", cvv: "4", otp: "5" }) as Record<
      string,
      unknown
    >;
    for (const value of Object.values(out)) {
      expect(value).toBe("[redacted]");
    }
  });

  it("redacts nested and array-held secrets", () => {
    expect(
      redact({ user: { name: "Ada", token: "t" }, items: [{ secret: "s" }] }),
    ).toEqual({ user: { name: "Ada", token: "[redacted]" }, items: [{ secret: "[redacted]" }] });
  });

  it("withholds SQL text by default because it can carry personal data", () => {
    expect(redact({ query: "select * from users where email = 'ada@example.com'" })).toEqual({
      query: "[redacted]",
    });
  });

  it("withholds the whole driver-diagnostics subtree, which quotes the offending row", () => {
    expect(
      redact({
        table: "parties",
        driverDetail: { detail: "Key (email)=(ada@example.com) already exists.", hint: null },
      }),
    ).toEqual({ table: "parties", driverDetail: "[redacted]" });
  });

  it("truncates very long strings so one log line cannot flood the stream", () => {
    const out = redact({ note: "x".repeat(5000) }) as { note: string };
    expect(out.note.length).toBeLessThan(5000);
    expect(out.note).toContain("truncated");
  });

  it("summarises an Error rather than emitting an empty object", () => {
    const out = redact(new Error("boom")) as Record<string, unknown>;
    expect(out).toMatchObject({ name: "Error", message: "boom" });
    expect(typeof out.stack).toBe("string");
  });

  it("survives a circular structure", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    expect(() => redact(node)).not.toThrow();
    expect(redact(node)).toEqual({ name: "root", self: "[circular]" });
  });

  it("stops descending past the depth limit instead of walking a huge object", () => {
    const deep = { a: { b: { c: { d: { e: { f: "bottom" } } } } } };
    expect(JSON.stringify(redact(deep))).toContain("[depth-limit]");
  });

  it("caps very large arrays", () => {
    const out = redact({ rows: Array.from({ length: 500 }, (_, i) => i) }) as {
      rows: unknown[];
    };
    expect(out.rows.length).toBeLessThan(500);
    expect(out.rows[out.rows.length - 1]).toContain("more");
  });
});
