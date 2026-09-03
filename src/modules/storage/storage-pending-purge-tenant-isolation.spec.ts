import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { storagePendingPurge } from "../../db/schema/common/storage-pending-purge";
import {
  StoragePendingPurgeService,
  PENDING_PURGE_MAX_ATTEMPTS,
} from "./storage-pending-purge.service";

/*
 * ── Why this table is a cross-tenant target ──────────────────────────────────
 *
 * `storage_pending_purge` is the only surviving pointer to an object that must be
 * deleted. A row names a tenant's storage key, and the sweep that reads a row DELETES
 * the object it names. A predicate that stopped binding `org_id` would therefore not
 * merely disclose another tenant's keys — the very next statement destroys their bytes.
 * That is why the negative below is behavioural and not a spelling check: the fake store
 * returns EVERY tenant's rows when no tenant predicate reaches it, exactly as a database
 * would, so dropping `eq(orgId)` leaks org B's key into org A's result and fails here.
 *
 * A cross-tenant key is ABSENT from the result, never an error. `listForRetry` answers a
 * foreign org with an empty list, so nothing distinguishes "you have no pending purges"
 * from "that key belongs to someone else" — the 404-never-403 shape at the edge above it.
 *
 * `markConfirmed` and `markFailed` now bind the tenant alongside the row's primary key,
 * so three things hold them: that predicate, the fact that the id can only have come from
 * the tenant-scoped read above, and the RLS policy on this table
 * (`USING (org_id = app.current_org_id())`, migration 0741) biting on the tenant
 * transaction the proxy in `common/tenant/tenant-db.ts` routes them into. Only the first
 * survives a call made outside a tenant context or by a role with BYPASSRLS. The last two
 * tests pin the first and the second together, so neither a read that stopped filtering
 * nor a predicate that stopped binding the org reaches a destructive update unnoticed.
 */

const dialect = new PgDialect();

const ORG_A = "org-aaaa-0000-tenant-a";
const ORG_B = "org-bbbb-1111-tenant-b";

const ROW_A = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: ORG_A,
  storageKey: "kb-media/tenant-a/quarterly-board-deck.pdf",
  purpose: "kb:page:purge",
};
const ROW_B = {
  id: "22222222-2222-4222-8222-222222222222",
  orgId: ORG_B,
  storageKey: "kb-media/tenant-b/payroll-export.csv",
  purpose: "kb:page:purge",
};

type StoredRow = typeof ROW_A;

function boundOrgs(statement: SQL): string[] {
  return dialect
    .sqlToQuery(statement)
    .params.filter((p): p is string => p === ORG_A || p === ORG_B);
}

function boundIds(statement: SQL): string[] {
  return dialect
    .sqlToQuery(statement)
    .params.filter((p): p is string => p === ROW_A.id || p === ROW_B.id);
}

interface Captured {
  selects: SQL[];
  updates: SQL[];
}

/**
 * The store a real database would be. When the predicate carries no tenant id it
 * returns every row it holds — that is the whole point: an unfiltered query is not
 * an empty query, it is a leaking one.
 */
function makeDb(rows: StoredRow[], captured: Captured): Db {
  return {
    select: () => ({
      from: () => ({
        where: (predicate: SQL) => {
          captured.selects.push(predicate);
          const orgs = boundOrgs(predicate);
          const visible =
            orgs.length === 0 ? rows : rows.filter((r) => orgs.includes(r.orgId));
          return {
            orderBy: () => ({
              limit: (n: number) =>
                Promise.resolve(
                  visible
                    .slice(0, n)
                    .map(({ id, storageKey, purpose }) => ({ id, storageKey, purpose })),
                ),
            }),
          };
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: (predicate: SQL) => {
          captured.updates.push(predicate);
          return Promise.resolve([]);
        },
      }),
    }),
  } as unknown as Db;
}

function build(rows: StoredRow[]): {
  service: StoragePendingPurgeService;
  captured: Captured;
} {
  const captured: Captured = { selects: [], updates: [] };
  return { service: new StoragePendingPurgeService(makeDb(rows, captured)), captured };
}

describe("StoragePendingPurgeService — cross-tenant isolation", () => {
  it("binds the caller's org on the retry scan and never another tenant's", async () => {
    const { service, captured } = build([ROW_A, ROW_B]);

    await service.listForRetry(ORG_A, 100);

    expect(captured.selects).toHaveLength(1);
    const rendered = dialect.sqlToQuery(captured.selects[0] as SQL);
    expect(rendered.params).toContain(ORG_A);
    expect(rendered.params).not.toContain(ORG_B);
    expect(rendered.sql).toContain('"org_id" =');
  });

  it("returns only the caller's keys when both tenants have rows waiting", async () => {
    const { service } = build([ROW_A, ROW_B]);

    const rows = await service.listForRetry(ORG_A, 100);

    expect(rows.map((r) => r.storageKey)).toEqual([ROW_A.storageKey]);
    expect(rows.map((r) => r.storageKey)).not.toContain(ROW_B.storageKey);
    expect(rows.map((r) => r.id)).not.toContain(ROW_B.id);
  });

  it("(bite proof, other direction) the same store read as org B yields only org B's keys", async () => {
    const { service } = build([ROW_A, ROW_B]);

    const rows = await service.listForRetry(ORG_B, 100);

    expect(rows.map((r) => r.storageKey)).toEqual([ROW_B.storageKey]);
    expect(rows.map((r) => r.storageKey)).not.toContain(ROW_A.storageKey);
  });

  it("answers a foreign tenant's backlog with an empty list, not an error", async () => {
    const { service } = build([ROW_B]);

    await expect(service.listForRetry(ORG_A, 100)).resolves.toEqual([]);
  });

  it("does not let the status or attempt predicates stand in for the tenant one", async () => {
    const { service, captured } = build([ROW_A, ROW_B]);

    await service.listForRetry(ORG_A, 100);

    const rendered = dialect.sqlToQuery(captured.selects[0] as SQL);
    expect(rendered.params).toContain("pending");
    expect(rendered.params).toContain("failed");
    expect(rendered.params).toContain(PENDING_PURGE_MAX_ATTEMPTS);
    expect(boundOrgs(captured.selects[0] as SQL)).toEqual([ORG_A]);
  });

  it("never hands a foreign tenant's row id to markConfirmed", async () => {
    const { service, captured } = build([ROW_A, ROW_B]);

    for (const row of await service.listForRetry(ORG_A, 100))
      await service.markConfirmed(ORG_A, row.id);

    expect(captured.updates).toHaveLength(1);
    expect(boundIds(captured.updates[0] as SQL)).toEqual([ROW_A.id]);
    expect(boundIds(captured.updates[0] as SQL)).not.toContain(ROW_B.id);
    expect(boundOrgs(captured.updates[0] as SQL)).toEqual([ORG_A]);
  });

  it("never hands a foreign tenant's row id to markFailed", async () => {
    const { service, captured } = build([ROW_A, ROW_B]);

    for (const row of await service.listForRetry(ORG_A, 100))
      await service.markFailed(ORG_A, row.id, "R2 unreachable");

    expect(captured.updates).toHaveLength(1);
    expect(boundIds(captured.updates[0] as SQL)).toEqual([ROW_A.id]);
    expect(boundIds(captured.updates[0] as SQL)).not.toContain(ROW_B.id);
    expect(boundOrgs(captured.updates[0] as SQL)).toEqual([ORG_A]);
  });

  it("keeps the tenant column NOT NULL, so the (org_id, storage_key) key cannot be evaded with a NULL", () => {
    expect(storagePendingPurge.orgId.name).toBe("org_id");
    expect(storagePendingPurge.orgId.notNull).toBe(true);
    expect(storagePendingPurge.storageKey.notNull).toBe(true);
  });
});
