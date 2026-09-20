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
  const db = {
    select: jest.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () =>
              rows.map((r) => ({ ...(r as object), windowTotal: String(total) })),
          }),
        }),
      }),
    })),
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

  it("does not forgive an altered row because nobody signed it", async () => {
    /*
     * Rows the system writes — detection sweeps, cron locks — have no actor.
     * A mismatch on such a row used to be counted as legacy and the chain
     * re-anchored on whatever hash it now carried, so editing `after` on a
     * system row and leaving its hash alone verified clean.
     */
    const rows = chainOf(3);
    const middle = rows[1] as Record<string, unknown>;
    middle.actorMembershipId = null;
    const svc = new TimesheetsAuditService(makeDb(rows, 3));

    const result = await svc.verifyChain(ORG, 10_000);

    expect(result).toMatchObject({ valid: false, brokenAtId: 2 });
    expect(result.legacyRows).toBe(0);
  });

  it("verifies a system-written row like any other when it is intact", async () => {
    const rows: Record<string, unknown>[] = [];
    let prevHash: string | null = null;
    for (let i = 1; i <= 3; i += 1) {
      const params = {
        orgId: ORG,
        actorMembershipId: i === 2 ? null : 1,
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
    const svc = new TimesheetsAuditService(makeDb(rows, 3));

    const result = await svc.verifyChain(ORG, 10_000);

    expect(result.valid).toBe(true);
    expect(result.verified).toBe(3);
    expect(result.legacyRows).toBe(0);
  });

  it("treats a hash erased after hashing began as a break, not a legacy row", async () => {
    /*
     * Hashless rows can only predate the chain, so they form a prefix. One
     * appearing after a hashed row is a hash that was removed — the cheapest
     * way to hide an edit — and is reported at that row rather than skipped.
     */
    const rows = chainOf(3);
    (rows[2] as Record<string, unknown>).rowHash = null;
    const svc = new TimesheetsAuditService(makeDb(rows, 3));

    const result = await svc.verifyChain(ORG, 10_000);

    expect(result).toMatchObject({ valid: false, brokenAtId: 3 });
    expect(result.verified).toBe(2);
  });

  it("still reports total and truncation when it finds a break", async () => {
    const rows = chainOf(3);
    (rows[1] as Record<string, unknown>).rowHash = "tampered";
    const svc = new TimesheetsAuditService(makeDb(rows, 500));

    const result = await svc.verifyChain(ORG, 3);

    expect(result).toMatchObject({ valid: false, brokenAtId: 2 });
    /* A break found early says nothing about what lies past the cut. */
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(500);
  });

  it("reads the count from count(*) OVER () so the total needs no second round trip", async () => {
    const rows = chainOf(3);
    const db = makeDb(rows, 3);
    const svc = new TimesheetsAuditService(db);

    await svc.verifyChain(ORG, 10_000);

    expect((db.select as jest.Mock).mock.calls).toHaveLength(1);
  });
});
