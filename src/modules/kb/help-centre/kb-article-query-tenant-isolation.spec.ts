import { ScopedRead } from "../../access/scoped-read";
import { ForbiddenException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbArticleQueryService } from "./kb-article-query.service";

const dialect = new PgDialect();
const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const ARTICLE_ID = 4242;

function actor(orgId: string): CurrentUserContext {
  return { userId: "user-1", orgId } as CurrentUserContext;
}

function sqlValues(where: SQL | undefined): unknown[] {
  if (!where) return [];
  return dialect.sqlToQuery(where).params;
}

const listQuery: Parameters<KbArticleQueryService["list"]>[1] = { limit: 20 };

function build(spaceIds: number[]) {
  const capturedWheres: SQL[] = [];
  const selectChain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "orderBy", "limit"])
    selectChain[method] = jest.fn().mockReturnValue(selectChain);
  selectChain.where = jest.fn((w: SQL) => {
    capturedWheres.push(w);
    return selectChain;
  });
  (selectChain as { then?: unknown }).then = (res: (v: unknown) => unknown) =>
    Promise.resolve([]).then(res);

  const versionsFindMany = jest.fn((opts: { where: SQL }) => {
    capturedWheres.push(opts.where);
    return Promise.resolve([]);
  });

  const db = {
    select: jest.fn().mockReturnValue(selectChain),
    query: { kbArticleVersions: { findMany: versionsFindMany } },
  };

  const assertArticleViewable = jest.fn().mockResolvedValue(undefined);
  const access = {
    getAccessibleSpaceIds: jest.fn().mockResolvedValue(spaceIds),
    assertArticleViewable,
  };

  const service = new KbArticleQueryService(db as never, access as never);
  return { service, capturedWheres, access, assertArticleViewable, db };
}

describe("KbArticleQueryService — cross-tenant isolation", () => {
  it("DENY: listVersions binds the caller's org, so another org's versions are unreachable", async () => {
    const { service, capturedWheres } = build([1]);

    await service.listVersions(actor(ATTACKER_ORG), ARTICLE_ID);

    const params = capturedWheres.flatMap(sqlValues);
    expect(params).toContain(ATTACKER_ORG);
    expect(params).not.toContain(OWNER_ORG);
  });

  it("CONTROL: listVersions for the owning org binds that org", async () => {
    const { service, capturedWheres } = build([1]);

    await service.listVersions(actor(OWNER_ORG), ARTICLE_ID);

    const params = capturedWheres.flatMap(sqlValues);
    expect(params).toContain(OWNER_ORG);
    expect(params).not.toContain(ATTACKER_ORG);
  });

  it("DENY: listVersions refuses an article the access service rejects", async () => {
    const { service, assertArticleViewable } = build([1]);
    assertArticleViewable.mockRejectedValueOnce(new ForbiddenException("no"));

    await expect(service.listVersions(actor(ATTACKER_ORG), ARTICLE_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("DENY: list is bound to the caller's org and to their accessible spaces", async () => {
    const { service, capturedWheres } = build([7, 9]);

    await service.list(actor(ATTACKER_ORG), listQuery, ScopedRead.of(ATTACKER_ORG, "u-1", "all"));

    const params = capturedWheres.flatMap(sqlValues);
    expect(params).toContain(ATTACKER_ORG);
    expect(params).not.toContain(OWNER_ORG);
    expect(params).toContain(7);
    expect(params).toContain(9);
  });

  it("DENY: list issues no query at all when the caller can reach no space", async () => {
    const { service, capturedWheres, db } = build([]);

    const result = await service.list(actor(ATTACKER_ORG), listQuery, ScopedRead.of(ATTACKER_ORG, "u-1", "all"));

    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
    expect(capturedWheres).toHaveLength(0);
  });

  it("DENY: scope none issues no query and never consults accessible spaces", async () => {
    const { service, access, db } = build([7]);

    const result = await service.list(actor(ATTACKER_ORG), listQuery, ScopedRead.of(ATTACKER_ORG, "u-1", "none"));

    expect(result.items).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
    expect(access.getAccessibleSpaceIds).not.toHaveBeenCalled();
  });
});
