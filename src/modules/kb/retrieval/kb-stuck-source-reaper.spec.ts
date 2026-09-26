import { PgDialect } from "drizzle-orm/pg-core";
import { eq, sql, type SQL } from "drizzle-orm";
import { kbSources } from "../../../db/schema";
import {
  KbStuckSourceReaperService,
  KB_SOURCE_REAP_BATCH,
  KB_SOURCE_STUCK_MESSAGE,
  reapOrgStuckSources,
} from "./kb-stuck-source-reaper.service";
import type { TenantTx } from "../../../common/tenant";
import { forEachOrg } from "../../../common/tenant";
import type { Db } from "../../../db/drizzle.module";

jest.mock("../../../common/tenant", () => ({ forEachOrg: jest.fn() }));

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;
const dialect = new PgDialect();

const ORG = "org-reap-1";

function makeQuota() {
  return { reserve: jest.fn(), release: jest.fn() };
}

function makeTx(
  reaped: Array<{
    id: number;
    kind?: string;
    noteText?: string | null;
    fileSize?: number | null;
  }> = [],
) {
  const captured: SQL[] = [];
  const capturedSet: Array<Record<string, unknown>> = [];
  const tx = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedSet.push(values);
        return {
          where: jest.fn().mockImplementation((cond: SQL) => {
            captured.push(cond);
            return { returning: jest.fn().mockResolvedValue(reaped) };
          }),
        };
      }),
    }),
  };
  return { tx: tx as unknown as TenantTx, captured, capturedSet };
}

function makeLease(overrides: Partial<{ unavailableCount: number; contendedCount: number; lostCount: number; lastUnavailableReason: string | null }> = {}) {
  return {
    health: jest.fn().mockReturnValue({
      unavailableCount: 0,
      contendedCount: 0,
      lostCount: 0,
      lastUnavailableReason: null,
      ...overrides,
    }),
  };
}

describe("reapOrgStuckSources — the predicate", () => {
  it("only touches live, still-processing rows older than the cutoff", async () => {
    const { tx, captured } = makeTx([]);
    await reapOrgStuckSources(tx, ORG, new Date("2026-09-01T00:00:00.000Z"));

    const rendered = dialect.sqlToQuery(captured[0]!);
    expect(rendered.sql).toContain(`"kb_sources"."org_id"`);
    expect(rendered.sql).toContain(`"kb_sources"."status"`);
    expect(rendered.sql).toContain(`"kb_sources"."deleted_at" is null`);
    expect(rendered.sql).toContain(`"kb_sources"."updated_at" <`);
    expect(rendered.params).toContain(ORG);
    expect(rendered.params).toContain("processing");
  });

  it("is bounded — one org cannot consume the whole sweep", async () => {
    const { tx, captured } = makeTx([]);
    await reapOrgStuckSources(tx, ORG, new Date());

    const rendered = dialect.sqlToQuery(captured[0]!);
    expect(rendered.sql).toContain("limit");
    expect(rendered.params).toContain(KB_SOURCE_REAP_BATCH);
  });

  it("writes an actionable errorMessage, not a bare status flip", async () => {
    const { tx, capturedSet } = makeTx([]);
    await reapOrgStuckSources(tx, ORG, new Date());

    expect(capturedSet[0]).toEqual({ status: "failed", errorMessage: KB_SOURCE_STUCK_MESSAGE });
    expect(KB_SOURCE_STUCK_MESSAGE).toContain("dead-letter");
  });

  it("counts only the rows it actually updated", async () => {
    const { tx } = makeTx([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(await reapOrgStuckSources(tx, ORG, new Date())).toMatchObject({ sourcesFailed: 3 });
  });
});

describe("reapOrgStuckSources — cross-tenant isolation", () => {
  const SWEEPING = "org-sweeping";
  const BYSTANDER = "org-bystander";

  function tenantSlot(cond: SQL): { text: string; params: unknown[]; bound: unknown } {
    const { sql: text, params } = dialect.sqlToQuery(cond);
    const slot = /"kb_sources"\."org_id"\s*=\s*\$(\d+)/i.exec(text);
    if (slot === null) throw new Error("the reaper UPDATE bound no kb_sources.org_id equality");
    return { text, params, bound: params[Number(slot[1]) - 1] };
  }

  it("binds the org it is sweeping, so another tenant's stuck rows are unreachable", async () => {
    const { tx, captured } = makeTx([]);
    await reapOrgStuckSources(tx, SWEEPING, new Date("2026-09-01T00:00:00.000Z"));

    const { params, bound } = tenantSlot(captured[0]!);
    expect(bound).toBe(SWEEPING);
    expect(params).not.toContain(BYSTANDER);
  });

  it("rebinds per tenant — the same statement run for a second org carries that org, not the first", async () => {
    const first = makeTx([]);
    await reapOrgStuckSources(first.tx, SWEEPING, new Date());
    const second = makeTx([]);
    await reapOrgStuckSources(second.tx, BYSTANDER, new Date());

    expect(tenantSlot(first.captured[0]!).bound).toBe(SWEEPING);
    expect(tenantSlot(second.captured[0]!).bound).toBe(BYSTANDER);
  });

  it("carries the tenant equality inside the id subquery the UPDATE narrows on", async () => {
    const { tx, captured } = makeTx([]);
    await reapOrgStuckSources(tx, SWEEPING, new Date());

    const { text } = tenantSlot(captured[0]!);
    const subquery = text.slice(text.indexOf("select"));
    expect(subquery).toMatch(/"kb_sources"\."org_id"\s*=\s*\$\d+/i);
    expect(text).not.toMatch(/where\s+true/i);
  });

  it("BITE: the slot check rejects a predicate that dropped the tenant equality", () => {
    const orgless = dialect.sqlToQuery(
      sql`${kbSources.id} in (select ${kbSources.id} from ${kbSources} where ${eq(
        kbSources.status,
        "processing",
      )})`,
    );
    expect(/"kb_sources"\."org_id"\s*=\s*\$\d+/i.test(orgless.sql)).toBe(false);
  });
});

describe("KbStuckSourceReaperService.reap — cross-tenant isolation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("gives each tenant its own bound org id across one sweep", async () => {
    const perOrg = new Map<string, SQL[]>();
    mockedForEachOrg.mockImplementation(async (_db, _sweep, fn) => {
      for (const orgId of ["org-sweep-a", "org-sweep-b"]) {
        const { tx, captured } = makeTx([{ id: 1 }]);
        await fn(tx, orgId);
        perOrg.set(orgId, captured);
      }
      return { organizations: 2, succeeded: 2, failed: 0 };
    });

    const service = new KbStuckSourceReaperService({} as unknown as Db, makeLease() as never, makeQuota() as never);
    await service.reap();

    for (const [orgId, captured] of perOrg) {
      const { sql: text, params } = dialect.sqlToQuery(captured[0]!);
      const slot = /"kb_sources"\."org_id"\s*=\s*\$(\d+)/i.exec(text);
      expect(params[Number(slot?.[1]) - 1]).toBe(orgId);
      expect(params).not.toContain(orgId === "org-sweep-a" ? "org-sweep-b" : "org-sweep-a");
    }
  });
});

describe("KbStuckSourceReaperService.reap", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("iterates tenants through forEachOrg — a background sweep has no ambient tenant context", async () => {
    const { tx } = makeTx([{ id: 7 }]);
    mockedForEachOrg.mockImplementation(async (_db, _sweep, fn) => {
      await fn(tx, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const service = new KbStuckSourceReaperService({} as unknown as Db, makeLease() as never, makeQuota() as never);
    const result = await service.reap();

    expect(mockedForEachOrg).toHaveBeenCalledWith(
      expect.anything(),
      "kb-stuck-source-reaper",
      expect.any(Function),
    );
    expect(result.sourcesFailed).toBe(1);
    expect(result.orgsProcessed).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("reports truncation when a tenant filled the batch, so the operator reruns", async () => {
    const { tx } = makeTx(Array.from({ length: KB_SOURCE_REAP_BATCH }, (_v, i) => ({ id: i })));
    mockedForEachOrg.mockImplementation(async (_db, _sweep, fn) => {
      await fn(tx, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const service = new KbStuckSourceReaperService({} as unknown as Db, makeLease() as never, makeQuota() as never);
    expect((await service.reap()).truncated).toBe(true);
  });

  it("returns the reserved bytes of every reaped source so the quota is not a one-way ratchet", async () => {
    const { tx } = makeTx([
      { id: 1, kind: "note", noteText: "abcde", fileSize: null },
      { id: 2, kind: "file", noteText: null, fileSize: 400 },
    ]);
    const quota = makeQuota();
    mockedForEachOrg.mockImplementation(async (_db, _sweep, fn) => {
      await fn(tx, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const service = new KbStuckSourceReaperService(
      {} as unknown as Db,
      makeLease() as never,
      quota as never,
    );
    const result = await service.reap();

    expect(quota.release).toHaveBeenCalledWith(ORG, 405);
    expect(result.sourcesFailed).toBe(2);
  });

  it("surfaces the ingestion lease health that nothing else reads", async () => {
    mockedForEachOrg.mockResolvedValue({ organizations: 0, succeeded: 0, failed: 0 });
    const lease = makeLease({ unavailableCount: 4, lostCount: 1, lastUnavailableReason: "ECONNREFUSED" });

    const service = new KbStuckSourceReaperService({} as unknown as Db, lease as never, makeQuota() as never);
    const result = await service.reap();

    expect(lease.health).toHaveBeenCalled();
    expect(result.leaseHealth).toEqual({
      unavailableCount: 4,
      contendedCount: 0,
      lostCount: 1,
      lastUnavailableReason: "ECONNREFUSED",
    });
  });
});
