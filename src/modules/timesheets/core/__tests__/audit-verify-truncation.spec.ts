import {
  TimesheetsAuditService,
  computeAuditRowHash,
} from "../timesheets-audit.service";
import type { Db } from "../../../../db/drizzle.module";

const ORG = "org-audit-verify";

/**
 * `verifyChain` reads the OLDEST `limit` events. On a chain longer than that,
 * everything past the cut is never examined — and the result used to say
 * `valid: true` all the same, with a `checked` count no caller could compare
 * against anything. A green tick over a partial check is worse than no check,
 * because it is believed.
 */
function makeDb(rows: unknown[], total: number): Db {
  const selectCalls: unknown[] = [];
  const db = {
    select: jest.fn((projection?: unknown) => {
      selectCalls.push(projection);
      /* The first select in verifyChain is the count; the second reads rows. */
      const isCount = selectCalls.length === 1;
      return {
        from: () => ({
          where: isCount
            ? async () => [{ n: String(total) }]
            : () => ({
                orderBy: () => ({
                  limit: async () => rows,
                }),
              }),
        }),
      };
    }),
  };
  return db as unknown as Db;
}

/** A row whose stored hash matches what the verifier will recompute. */
function chainOf(count: number) {
  const rows: Record<string, unknown>[] = [];
  let prevHash: string | null = null;
  for (let i = 1; i <= count; i += 1) {
    const params = {
      orgId: ORG,
      actorMembershipId: 1,
      entityType: "period",
      entityId: String(i),
      action: "approve",
      before: null,
      after: null,
      reason: undefined,
    };
    const rowHash = computeAuditRowHash(prevHash, params);
    rows.push({ ...params, id: i, reason: null, prevHash, rowHash });
    prevHash = rowHash;
  }
  return rows;
}

describe("TimesheetsAuditService.verifyChain", () => {
  it("says the check was truncated when the chain is longer than the window", async () => {
    const rows = chainOf(3);
    const svc = new TimesheetsAuditService(makeDb(rows, 90_000));

    const result = await svc.verifyChain(ORG, 3);

    expect(result.valid).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(90_000);
    expect(result.verified).toBe(3);
  });

  it("says the check was complete when the whole chain fits", async () => {
    const rows = chainOf(3);
    const svc = new TimesheetsAuditService(makeDb(rows, 3));

    const result = await svc.verifyChain(ORG, 10_000);

    expect(result.valid).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(3);
  });

  it("counts hashless legacy rows apart from verified ones", async () => {
    /*
     * A chain that is "valid" over 400 rows of which 380 predate hashing is a
     * much weaker statement than one over 400 hashed rows, and the caller can
     * only tell the difference if the two are reported separately.
     */
    const rows = chainOf(2);
    rows.unshift({ ...rows[0], id: 0, rowHash: null, prevHash: null });
    const svc = new TimesheetsAuditService(makeDb(rows, 3));

    const result = await svc.verifyChain(ORG, 10_000);

    expect(result.legacyRows).toBe(1);
    expect(result.verified).toBe(2);
    expect(result.checked).toBe(3);
  });

  it("still reports total and truncation when it finds a break", async () => {
    const rows = chainOf(3);
    (rows[1] as Record<string, unknown>).rowHash = "tampered";
    const svc = new TimesheetsAuditService(makeDb(rows, 500));

    const result = await svc.verifyChain(ORG, 3);

    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(2);
    /* A break found early says nothing about what lies past the cut. */
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(500);
  });
});
