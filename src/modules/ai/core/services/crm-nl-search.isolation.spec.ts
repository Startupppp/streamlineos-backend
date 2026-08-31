jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { CrmNlSearchService } from "./crm-nl-search.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { AiGatewayService } from "../gateway/ai-gateway.service";
import type { Db } from "../../../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function makeGateway(parsedFilters: Record<string, unknown> = {}) {
  return {
    invokeStructured: jest.fn().mockResolvedValue({
      ok: true,
      data: parsedFilters,
      model: "test",
      latencyMs: 1,
      correlationId: "c",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }),
  } as unknown as AiGatewayService;
}

function makeDb(): Db {
  return {
    select: jest.fn(),
    query: {},
  } as unknown as Db;
}

beforeEach(() => {
  jest.resetAllMocks();
  (runInTenantTransaction as jest.Mock).mockImplementation(
    (_db: unknown, _fn: unknown, opts: { orgId: string }) => {
      return Promise.resolve({ orgId: opts.orgId, rows: [] });
    },
  );
});

describe("CrmNlSearchService — cross-tenant isolation", () => {
  it("nlSearch scopes the runInTenantTransaction call to the requesting orgId — cross-org isolation", async () => {
    const db = makeDb();
    const svc = new CrmNlSearchService(db, makeGateway());

    (runInTenantTransaction as jest.Mock).mockImplementation(
      (_db: unknown, _fn: unknown, opts: { orgId: string }) => {
        return Promise.resolve([]);
      },
    );

    await svc.nlSearch(ATTACKER_ORG, { query: "hot leads" });

    expect(runInTenantTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({ orgId: ATTACKER_ORG }),
    );
  });

  it("nlSearch passes different orgId per caller — tenant isolation boundary", async () => {
    const db = makeDb();
    const svc = new CrmNlSearchService(db, makeGateway());
    const capturedOrgIds: string[] = [];

    (runInTenantTransaction as jest.Mock).mockImplementation(
      (_db: unknown, _fn: unknown, opts: { orgId: string }) => {
        capturedOrgIds.push(opts.orgId);
        return Promise.resolve([]);
      },
    );

    await svc.nlSearch(ATTACKER_ORG, { query: "leads" });
    await svc.nlSearch(OWNER_ORG, { query: "leads" });

    expect(capturedOrgIds).toEqual([ATTACKER_ORG, OWNER_ORG]);
  });

  it("nlSearch returns empty leads when transaction returns no rows (DENY for wrong org)", async () => {
    const db = makeDb();
    const svc = new CrmNlSearchService(db, makeGateway());

    (runInTenantTransaction as jest.Mock).mockImplementation(
      (_db: unknown, _fn: unknown, _opts: unknown) => Promise.resolve([]),
    );

    const result = await svc.nlSearch(ATTACKER_ORG, { query: "qualified leads" });
    expect(result.leads).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
