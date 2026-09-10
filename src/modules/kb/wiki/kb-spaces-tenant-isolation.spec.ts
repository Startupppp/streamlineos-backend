import { humanSessionPrincipal } from "../../../common/auth/principal";
import { ScopedRead } from "../../access/scoped-read";
import type { Db } from "../../../db/drizzle.module";
import { KbSpacesService } from "./kb-spaces.service";
import type { KbAccessService } from "../core/kb-access.service";
import { KbIndexingService } from "../retrieval/kb-indexing.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeChain(rows: unknown[] = []): object {
  return Object.assign(Promise.resolve(rows), {
    limit: jest.fn().mockImplementation(() => makeChain(rows)),
    offset: jest.fn().mockImplementation(() => makeChain(rows)),
    orderBy: jest.fn().mockImplementation(() => makeChain(rows)),
    groupBy: jest.fn().mockImplementation(() => makeChain(rows)),
  });
}

function makeUser(orgId: string): CurrentUserContext {
  return {
    orgId,
    userId: "user-1",
    membershipId: 1,
    role: "MEMBER",
    isOwner: false,
    principal: humanSessionPrincipal(1, false),
  } as never;
}

function makeService(orgId: string, rows: unknown[]): { svc: KbSpacesService; allWhereArgs: unknown[] } {
  const allWhereArgs: unknown[] = [];
  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((arg: unknown) => {
          allWhereArgs.push(arg);
          return makeChain(rows);
        }),
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((arg: unknown) => {
            allWhereArgs.push(arg);
            return makeChain(rows);
          }),
        }),
      }),
    })),
  } as unknown as Db;
  const access = {
    getAccessibleSpaceIds: jest.fn().mockResolvedValue([1, 2, 3]),
  } as unknown as KbAccessService;
  const indexing = new KbIndexingService(db, undefined as never, undefined as never);
  return { svc: new KbSpacesService(db, access, indexing), allWhereArgs };
}

describe("KbSpacesService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes space list to the requesting org (tenant isolation)", async () => {
    const { svc, allWhereArgs } = makeService(ATTACKER_ORG, []);

    await svc.list(makeUser(ATTACKER_ORG), ScopedRead.of(ATTACKER_ORG, "u-1", "all"));

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns spaces for the owning org (same-tenant control)", async () => {
    const space = { id: 1, orgId: OWNER_ORG, name: "General", slug: "general", articleCount: 0 };
    const { svc } = makeService(OWNER_ORG, [space]);

    const result = await svc.list(makeUser(OWNER_ORG), ScopedRead.of(OWNER_ORG, "u-1", "all"));

    expect(result).toBeDefined();
  });
});
