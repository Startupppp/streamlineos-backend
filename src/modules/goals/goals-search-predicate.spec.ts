jest.mock("./goal-links.service");

import type { Db } from "../../db/drizzle.types";
import { GoalsService } from "./goals.service";
import { GoalLinksService } from "./goal-links.service";
import { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const ORG = "org-goals-search";

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

function makeThenable(resolved: unknown[]): jest.Mock {
  const fn = jest.fn();
  fn.mockImplementation(() => {
    const obj: Record<string, unknown> = {};
    for (const m of ["from", "where", "groupBy", "leftJoin", "innerJoin", "orderBy", "limit", "offset"]) {
      obj[m] = jest.fn(() => obj);
    }
    obj["then"] = (res: (v: unknown) => unknown) => Promise.resolve(resolved).then(res);
    return obj;
  });
  return fn;
}

function makeDb(captured: { where: unknown }) {
  const countChain = makeThenable([{ total: 0 }]);
  const findMany = jest.fn().mockImplementation((opts: { where: unknown }) => {
    captured.where = opts.where;
    return Promise.resolve([]);
  });
  const select = jest.fn().mockImplementation(() => countChain());
  return {
    query: {
      okrGoals: { findMany, findFirst: jest.fn() },
      okrKeyResults: { findMany: jest.fn().mockResolvedValue([]) },
      okrUpdates: { findMany: jest.fn().mockResolvedValue([]) },
    },
    select,
    update: jest.fn(),
    insert: jest.fn(),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  } as unknown as Db;
}

function makeAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["build:goals:manage", "all"]])),
  } as unknown as AccessService;
}

function makeUser(): CurrentUserContext {
  return {
    orgId: ORG,
    userId: "u-search",
    role: "MEMBER",
    isOrgOwner: true,
    sessionId: "s-1",
    tokenScopes: null,
    principal: { kind: "human-session" as const, membershipId: 1, isOrgOwner: true },
  };
}

describe("GoalsService.list — server-side full-text search predicate (BE-49, BE-80)", () => {
  it("includes the search term as a WHERE param so the DB filters rather than the caller — to_tsvector/plainto_tsquery not leading-ILIKE", async () => {
    const captured: { where: unknown } = { where: undefined };
    const svc = new GoalsService(makeDb(captured), makeAccess(), new GoalLinksService({} as Db));
    await svc.list(makeUser(), { page: 1, limit: 20, search: "quarterly-revenue" });
    const params = collectParamValues(captured.where);
    expect(params).toContain("quarterly-revenue");
  });

  it("keeps orgId in WHERE alongside the search term so a matching goal from another org is never returned", async () => {
    const captured: { where: unknown } = { where: undefined };
    const svc = new GoalsService(makeDb(captured), makeAccess(), new GoalLinksService({} as Db));
    await svc.list(makeUser(), { page: 1, limit: 20, search: "quarterly-revenue" });
    const params = collectParamValues(captured.where);
    expect(params).toContain("quarterly-revenue");
    expect(params).toContain(ORG);
  });

  it("omits the search predicate when no search term is given so all org goals are returned", async () => {
    const captured: { where: unknown } = { where: undefined };
    const svc = new GoalsService(makeDb(captured), makeAccess(), new GoalLinksService({} as Db));
    await svc.list(makeUser(), { page: 1, limit: 20 });
    const params = collectParamValues(captured.where);
    expect(params).not.toContain("quarterly-revenue");
    expect(params).toContain(ORG);
  });
});
