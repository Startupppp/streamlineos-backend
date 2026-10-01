import { FormsService } from "./forms.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { MEMBER_STANDING, projectAccessRow, standingAccess } from "../core/project-crud/__tests__/project-access-doubles";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => {
  jest.resetAllMocks();
});

function makeU(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, false),
  };
}

function makeChain(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

function hasOwnPropStr<K extends string>(obj: object, key: K): obj is Record<K, unknown> {
  return key in obj;
}

function collectParamValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (node === null || node === undefined) return acc;
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    acc.push(node);
    return acc;
  }
  if (typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectParamValues(item, acc);
    return acc;
  }
  if (hasOwnPropStr(node, "encoder") && hasOwnPropStr(node, "value")) {
    acc.push(node.value);
    return acc;
  }
  if (hasOwnPropStr(node, "queryChunks")) {
    const qc = node.queryChunks;
    if (Array.isArray(qc)) {
      for (const chunk of qc) collectParamValues(chunk, acc);
    }
  }
  return acc;
}

function makeMockDb() {
  return {
    select: jest.fn().mockReturnValue(makeChain([])),
  };
}

function makeAccessService(): AccessService {
  return standingAccess(MEMBER_STANDING) as unknown as AccessService;
}

describe("FormsService.listForms — server-side full-text search predicate", () => {
  const u = makeU("org-1");

  function setupMocks(
    mockDb: ReturnType<typeof makeMockDb>,
    formChain: ReturnType<typeof makeChain>,
  ) {
    mockDb.select
      .mockReturnValueOnce(makeChain([projectAccessRow({ memberRole: "MEMBER" })]))
      .mockReturnValueOnce(formChain);
  }

  it("includes the search term as a WHERE param so the DB filters rather than the caller", async () => {
    const mockDb = makeMockDb();
    const formChain = makeChain([]);
    setupMocks(mockDb, formChain);
    const svc = new FormsService(mockDb as unknown as Db, makeAccessService(), mockAudit);

    await svc.listForms(u, 1, { q: "intake-keyword" });

    const whereArg: unknown = formChain.where.mock.calls[0]?.[0];
    expect(collectParamValues(whereArg)).toContain("intake-keyword");
  });

  it("does not include a search param for 'intake-keyword' in WHERE when no search is provided", async () => {
    const mockDb = makeMockDb();
    const formChain = makeChain([]);
    setupMocks(mockDb, formChain);
    const svc = new FormsService(mockDb as unknown as Db, makeAccessService(), mockAudit);

    await svc.listForms(u, 1, {});

    const whereArg: unknown = formChain.where.mock.calls[0]?.[0];
    expect(collectParamValues(whereArg)).not.toContain("intake-keyword");
  });

  it("keeps orgId and projectId in WHERE beside the search term, which is the only reason the measured cost of search is a heap filter over one project's rows: a GIN index on the name+description expression is never chosen under RLS because ts_match_vq is not leakproof and so cannot be evaluated before the tenant qual (BE-80)", async () => {
    const mockDb = makeMockDb();
    const formChain = makeChain([]);
    setupMocks(mockDb, formChain);
    const svc = new FormsService(mockDb as unknown as Db, makeAccessService(), mockAudit);

    await svc.listForms(u, 4242, { q: "onboarding-form" });

    const whereArg: unknown = formChain.where.mock.calls[0]?.[0];
    const params = collectParamValues(whereArg);
    expect(params).toContain("onboarding-form");
    expect(params).toContain("org-1");
    expect(params).toContain(4242);
  });
});
