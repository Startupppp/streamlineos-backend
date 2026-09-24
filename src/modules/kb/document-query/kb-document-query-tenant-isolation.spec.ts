import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import type { KbAccessService } from "../core/kb-access.service";
import type { AccessService } from "../../access/access.service";
import { KbDocumentQueryService } from "./kb-document-query.service";

const dialect = new PgDialect();
const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function actor(orgId: string): CurrentUserContext {
  return {
    orgId,
    userId: "user-1",
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "session",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
  };
}

function makeHarness() {
  const articleWheres: SQL[] = [];
  const pageWheres: SQL[] = [];
  let selectCallCount = 0;

  const articleChain: Record<string, unknown> = {};
  Object.assign(articleChain, {
    from: () => articleChain,
    where: (cond: SQL) => {
      articleWheres.push(cond);
      return articleChain;
    },
    orderBy: () => articleChain,
    limit: () => Promise.resolve([]),
  });

  const pageChain: Record<string, unknown> = {};
  Object.assign(pageChain, {
    from: () => pageChain,
    where: (cond: SQL) => {
      pageWheres.push(cond);
      return pageChain;
    },
    orderBy: () => pageChain,
    limit: () => Promise.resolve([]),
  });

  const db = {
    select: jest.fn(() => {
      selectCallCount += 1;
      return selectCallCount === 1 ? articleChain : pageChain;
    }),
  } as unknown as Db;

  const kbAccess = {
    getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
    isAdmin: jest.fn().mockResolvedValue(true),
    getPrincipalIds: jest.fn().mockResolvedValue({
      userId: "user-1",
      membershipId: 1,
      roleSlugs: [],
    }),
  } as unknown as KbAccessService;

  const access = {
    scopeFor: jest.fn().mockResolvedValue("all"),
  } as unknown as AccessService;

  const auth = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
  };

  const service = new KbDocumentQueryService(db, kbAccess, access, auth as never);
  return { service, articleWheres, pageWheres };
}

describe("KbDocumentQueryService — tenant isolation", () => {
  it("page query binds the attacker org and excludes the owner org (cross-tenant isolation — pages)", async () => {
    const { service, pageWheres } = makeHarness();

    await service.searchDocuments(actor(ATTACKER_ORG), "test", 10);

    expect(pageWheres).toHaveLength(1);
    const params = dialect.sqlToQuery(pageWheres[0]!).params;
    expect(params).toContain(ATTACKER_ORG);
    expect(params).not.toContain(OWNER_ORG);
  });

  it("page query binds the owner org and excludes the attacker org (same-tenant control — pages)", async () => {
    const { service, pageWheres } = makeHarness();

    await service.searchDocuments(actor(OWNER_ORG), "test", 10);

    expect(pageWheres).toHaveLength(1);
    const params = dialect.sqlToQuery(pageWheres[0]!).params;
    expect(params).toContain(OWNER_ORG);
    expect(params).not.toContain(ATTACKER_ORG);
  });

  it("article query binds the attacker org and excludes the owner org (cross-tenant isolation — articles)", async () => {
    const { service, articleWheres } = makeHarness();

    await service.searchDocuments(actor(ATTACKER_ORG), "test", 10);

    expect(articleWheres).toHaveLength(1);
    const params = dialect.sqlToQuery(articleWheres[0]!).params;
    expect(params).toContain(ATTACKER_ORG);
    expect(params).not.toContain(OWNER_ORG);
  });

  it("article query binds the owner org and excludes the attacker org (same-tenant control — articles)", async () => {
    const { service, articleWheres } = makeHarness();

    await service.searchDocuments(actor(OWNER_ORG), "test", 10);

    expect(articleWheres).toHaveLength(1);
    const params = dialect.sqlToQuery(articleWheres[0]!).params;
    expect(params).toContain(OWNER_ORG);
    expect(params).not.toContain(ATTACKER_ORG);
  });
});
