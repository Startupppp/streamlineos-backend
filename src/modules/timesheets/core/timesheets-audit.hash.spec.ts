import { computeAuditRowHash, stableStringify, TimesheetsAuditService } from "./timesheets-audit.service";

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

describe("TimesheetsAuditService.recordMany", () => {
  const base = {
    orgId: "org-1",
    actorMembershipId: 7,
    entityType: "period",
    action: "period.rejected",
    reason: "missing entries",
  };
  const events = [
    { ...base, entityId: "1" },
    { ...base, entityId: "2" },
    { ...base, entityId: "3" },
  ];

  function makeDbLike(tailHash: string | null) {
    const captured: Record<string, unknown>[][] = [];
    const selectChain = {
      from: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn().mockResolvedValue(tailHash === null ? [] : [{ rowHash: tailHash }]),
    };
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);
    selectChain.orderBy.mockReturnValue(selectChain);
    const statements: string[] = [];
    const dbLike = {
      execute: jest.fn().mockImplementation((query: unknown) => {
        statements.push(`execute:${sqlText(query)}`);
        return Promise.resolve([]);
      }),
      select: jest.fn().mockImplementation(() => {
        statements.push("select");
        return selectChain;
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockImplementation((rows: Record<string, unknown>[]) => {
          captured.push(rows);
          statements.push("insert");
          return Promise.resolve();
        }),
      }),
    };
    return { dbLike, captured, statements };
  }

  function sqlText(query: unknown): string {
    const chunks = Reflect.get(Object(query), "queryChunks");
    if (!Array.isArray(chunks)) return String(query);
    return chunks
      .map((chunk: unknown) => {
        if (typeof chunk === "string") return chunk;
        if (chunk && typeof chunk === "object" && "value" in chunk) return String(Reflect.get(chunk, "value"));
        return "";
      })
      .join("");
  }

  it("takes the organisation's chain lock before it reads the tail", async () => {
    const { dbLike, statements } = makeDbLike("tail-hash");
    const service = new TimesheetsAuditService(dbLike as never);

    await service.recordMany(dbLike as never, events);

    expect(statements[0]).toMatch(/^execute:SELECT pg_advisory_xact_lock\(/);
    expect(statements[0]).toContain("timesheets-audit:org-1");
    expect(statements.slice(1)).toEqual(["select", "insert"]);
  });

  it("record takes the same lock before its tail read", async () => {
    const { dbLike, statements } = makeDbLike("tail-hash");
    const service = new TimesheetsAuditService(dbLike as never);

    await service.record(dbLike as never, events[0]);

    expect(statements[0]).toMatch(/^execute:SELECT pg_advisory_xact_lock\(/);
    expect(statements[0]).toContain("timesheets-audit:org-1");
    expect(statements.slice(1)).toEqual(["select", "insert"]);
  });

  it("reads the chain tail once and writes one INSERT for the whole batch", async () => {
    const { dbLike, captured } = makeDbLike("tail-hash");
    const service = new TimesheetsAuditService(dbLike as never);

    await service.recordMany(dbLike as never, events);

    expect(dbLike.select).toHaveBeenCalledTimes(1);
    expect(dbLike.insert).toHaveBeenCalledTimes(1);
    expect(captured[0]).toHaveLength(3);
  });

  it("produces exactly the chain a per-row loop would have written", async () => {
    const { dbLike, captured } = makeDbLike("tail-hash");
    const service = new TimesheetsAuditService(dbLike as never);

    await service.recordMany(dbLike as never, events);

    const rows = captured[0];
    let expectedPrev: string | null = "tail-hash";
    for (const [index, event] of events.entries()) {
      const row = rows[index];
      expect(row["prevHash"]).toBe(expectedPrev);
      expect(row["rowHash"]).toBe(computeAuditRowHash(expectedPrev, event));
      expectedPrev = String(row["rowHash"]);
    }
  });

  it("starts from a null prevHash when the org has no prior events", async () => {
    const { dbLike, captured } = makeDbLike(null);
    const service = new TimesheetsAuditService(dbLike as never);

    await service.recordMany(dbLike as never, events);

    expect(captured[0][0]["prevHash"]).toBeNull();
  });

  it("writes nothing at all for an empty batch", async () => {
    const { dbLike } = makeDbLike("tail-hash");
    const service = new TimesheetsAuditService(dbLike as never);

    await service.recordMany(dbLike as never, []);

    expect(dbLike.execute).not.toHaveBeenCalled();
    expect(dbLike.select).not.toHaveBeenCalled();
    expect(dbLike.insert).not.toHaveBeenCalled();
  });
});
