import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { CrmCustomer360FinanceService } from "../crm-customer360-finance.service";
import { CrmCustomer360SectionsService } from "../crm-customer360-sections.service";
import type { CrmCustomer360FinanceService as FinanceDep } from "../crm-customer360-finance.service";
import type { CrmCustomer360EngagementService } from "../crm-customer360-engagement.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeSelectDb(rows: unknown[] = []): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const builder: Record<string, unknown> & { then: (r: (v: unknown) => void) => void } = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    where,
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    offset: jest.fn(),
    then: (resolve: (v: unknown) => void) => resolve(rows),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.leftJoin as jest.Mock).mockReturnValue(builder);
  (builder.innerJoin as jest.Mock).mockReturnValue(builder);
  (builder.where as jest.Mock).mockReturnValue(builder);
  (builder.orderBy as jest.Mock).mockReturnValue(builder);
  (builder.offset as jest.Mock).mockReturnValue(builder);
  const db = {
    select: jest.fn().mockReturnValue(builder),
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as Db;
  return { db, where };
}

const ATTACKER_ORG = "org-attacker-aaaa";
const VICTIM_ORG = "org-victim-bbbb";

describe("CrmCustomer360FinanceService — cross-tenant isolation", () => {
  it("fetchDealsForClient scopes to the requesting org — attacker org receives empty result", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new CrmCustomer360FinanceService(db);

    const result = await svc.fetchDealsForClient(ATTACKER_ORG, 99);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("fetchDealsForOrg uses orgId in WHERE — victim org predicate never bleeds into attacker query", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new CrmCustomer360FinanceService(db);

    await svc.fetchDealsForOrg(ATTACKER_ORG, "Acme Corp");

    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(VICTIM_ORG);
  });

  it("fetchQuotesForClient scopes to requesting org — cross-tenant isolation: wrong org yields zero rows", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new CrmCustomer360FinanceService(db);

    const result = await svc.fetchQuotesForClient(ATTACKER_ORG, 7);

    expect(result.items).toEqual([]);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("fetchInvoicesForClient scopes to requesting org — BOLA probe returns empty for wrong-org client", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new CrmCustomer360FinanceService(db);

    const result = await svc.fetchInvoicesForClient(ATTACKER_ORG, 3);

    expect(result.items).toEqual([]);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("fetchPaymentsForOrg scopes to requesting org — different org gets no payments", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new CrmCustomer360FinanceService(db);

    const result = await svc.fetchPaymentsForOrg(ATTACKER_ORG);

    expect(result.items).toEqual([]);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });
});

describe("CrmCustomer360SectionsService — cross-tenant isolation", () => {
  function makeFinanceDep(): FinanceDep {
    return {
      fetchDealsForOrg: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchDealsForClient: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchQuotesForOrg: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchQuotesForClient: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchInvoicesForOrg: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchInvoicesForClient: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchPaymentsForOrg: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchPaymentsForClient: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    } as unknown as FinanceDep;
  }

  function makeEngagementDep(): CrmCustomer360EngagementService {
    return {
      fetchSupportTicketsForOrg: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchSupportTicketsForClient: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchSurveysForOrg: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchSurveysForClient: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchProjectsForOrg: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchProjectsForClient: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchSignedDocumentsForOrg: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      fetchSignedDocumentsForClient: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    } as unknown as CrmCustomer360EngagementService;
  }

  it("fetchLeadsForOrg scopes to requesting org — cross-tenant isolation: attacker org gets empty leads", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new CrmCustomer360SectionsService(db, makeFinanceDep(), makeEngagementDep());

    const result = await svc.fetchLeadsForOrg(ATTACKER_ORG, "Target Inc");

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("fetchLeadsForOrg DOES NOT expose victim org data — different org predicate never appears in attacker query", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new CrmCustomer360SectionsService(db, makeFinanceDep(), makeEngagementDep());

    await svc.fetchLeadsForOrg(ATTACKER_ORG, "Any Company");

    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(VICTIM_ORG);
  });
});
