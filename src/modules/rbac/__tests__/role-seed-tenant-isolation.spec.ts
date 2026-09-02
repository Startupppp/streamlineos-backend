import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  actingMembershipId,
  humanSessionPrincipal,
  principalIsOrgOwner,
} from "../../../common/auth/principal";
import { RoleSeedService } from "../role-seed.service";
import { seedSystemRolesForOrg } from "../seed-system-roles";

jest.mock("../seed-system-roles", () => ({
  seedSystemRolesForOrg: jest.fn().mockResolvedValue(undefined),
}));

type Row = Record<string, unknown>;
type Store = Map<string, Row[]>;

type PredicateToken =
  | { kind: "column"; name: string }
  | { kind: "param"; value: unknown }
  | { kind: "text"; text: string };

interface Comparison {
  column: string;
  operator: "eq" | "in";
  values: unknown[];
}

function tokenize(node: unknown, out: PredicateToken[]): PredicateToken[] {
  if (Array.isArray(node)) {
    for (const item of node) tokenize(item, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;

  const columnName = Reflect.get(node, "name");
  if (typeof columnName === "string" && Reflect.get(node, "table") !== undefined) {
    out.push({ kind: "column", name: columnName });
    return out;
  }

  const chunks = Reflect.get(node, "queryChunks");
  if (Array.isArray(chunks)) return tokenize(chunks, out);

  const value = Reflect.get(node, "value");
  if (node.constructor.name === "StringChunk") {
    out.push({ kind: "text", text: Array.isArray(value) ? value.join("") : String(value) });
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(node, "value"))
    out.push({ kind: "param", value });
  return out;
}

function parseConjunction(tokens: PredicateToken[]): Comparison[] {
  const out: Comparison[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.kind === "text" && / or /.test(token.text))
      throw new Error(`isolation double: disjunctions are not interpreted (${token.text})`);
    if (token.kind !== "column") continue;

    const operator = tokens[i + 1];
    if (operator === undefined || operator.kind !== "text")
      throw new Error(`isolation double: no operator after column ${token.name}`);

    const values: unknown[] = [];
    let cursor = i + 2;
    for (let next = tokens[cursor]; next !== undefined && next.kind === "param"; next = tokens[cursor]) {
      values.push(next.value);
      cursor += 1;
    }

    const symbol = operator.text.trim();
    if (symbol === "=") out.push({ column: token.name, operator: "eq", values: values.slice(0, 1) });
    else if (symbol === "in") out.push({ column: token.name, operator: "in", values });
    else throw new Error(`isolation double: unsupported operator "${symbol}"`);
    i = cursor - 1;
  }
  return out;
}

function camelCase(column: string): string {
  return column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function rowMatches(row: Row, comparisons: Comparison[], ignoreTenantPredicate: boolean): boolean {
  return comparisons.every((comparison) => {
    if (ignoreTenantPredicate && comparison.column === "org_id") return true;
    const actual = row[camelCase(comparison.column)];
    if (comparison.operator === "eq") return actual === comparison.values[0];
    return comparison.values.includes(actual);
  });
}

function project(row: Row, projection: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [alias, column] of Object.entries(projection)) {
    const name = column === null || typeof column !== "object" ? undefined : Reflect.get(column, "name");
    out[alias] = typeof name === "string" ? row[camelCase(name)] : undefined;
  }
  return out;
}

function matching(store: Store, table: Table, condition: SQL | undefined, ignore: boolean): Row[] {
  const rows = store.get(getTableName(table)) ?? [];
  if (condition === undefined) return [...rows];
  return rows.filter((row) => rowMatches(row, parseConjunction(tokenize(condition, [])), ignore));
}

interface Harness {
  db: Db;
  store: Store;
  transactionCallbackRuns: () => number;
}

function makeHarness(store: Store, ignoreTenantPredicate = false): Harness {
  let nextId = 500;
  let transactionRuns = 0;

  const selectBuilder = (projection?: Record<string, unknown>) => {
    let table: Table | null = null;
    let condition: SQL | undefined;
    const resolve = (): Row[] => {
      if (table === null) return [];
      const rows = matching(store, table, condition, ignoreTenantPredicate);
      return projection === undefined ? rows : rows.map((row) => project(row, projection));
    };
    const builder = {
      from: (source: Table) => {
        table = source;
        return builder;
      },
      leftJoin: () => builder,
      innerJoin: () => builder,
      where: (predicate: SQL) => {
        condition = predicate;
        return builder;
      },
      orderBy: () => builder,
      limit: (count: number) => Promise.resolve(resolve().slice(0, count)),
      then: (onFulfilled?: (rows: Row[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return builder;
  };

  const insertBuilder = (table: Table) => {
    let pending: Row[] = [];
    const apply = (): Row[] => {
      const name = getTableName(table);
      const inserted = pending.map((row) => {
        nextId += 1;
        return { id: nextId, ...row };
      });
      store.set(name, [...(store.get(name) ?? []), ...inserted]);
      return inserted;
    };
    const builder = {
      values: (rows: Row | Row[]) => {
        pending = Array.isArray(rows) ? rows : [rows];
        return builder;
      },
      onConflictDoUpdate: () => Promise.resolve(apply()),
      returning: (projection?: Record<string, unknown>) => {
        const inserted = apply();
        return Promise.resolve(
          projection === undefined ? inserted : inserted.map((row) => project(row, projection)),
        );
      },
      then: (onFulfilled?: (rows: Row[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(apply()).then(onFulfilled, onRejected),
    };
    return builder;
  };

  const findFirst = (name: string) => async ({ where }: { where?: SQL }): Promise<Row | undefined> => {
    const rows = store.get(name) ?? [];
    if (where === undefined) return rows[0];
    return rows.find((row) =>
      rowMatches(row, parseConjunction(tokenize(where, [])), ignoreTenantPredicate),
    );
  };

  const queries = {
    select: jest.fn(selectBuilder),
    insert: jest.fn(insertBuilder),
    execute: jest.fn().mockResolvedValue([]),
    query: {
      roles: { findFirst: jest.fn(findFirst("roles")) },
      organizationMembers: { findFirst: jest.fn(findFirst("organization_members")) },
    },
  };

  const handle = {
    ...queries,
    transaction: jest.fn(async (callback: (tx: typeof queries) => Promise<unknown>) => {
      transactionRuns += 1;
      return callback(queries);
    }),
  };

  return {
    db: handle as unknown as Db,
    store,
    transactionCallbackRuns: () => transactionRuns,
  };
}

const ORG_A = "org-victim";
const ORG_B = "org-attacker";
const STARTER_SLUGS = [
  "ENGINEERING",
  "SALES_REP",
  "CUSTOMER_SUPPORT",
  "DIGITAL_MARKETING",
  "HR_ADMIN",
  "ACCOUNTANT",
];

function storeWithOrgBStarterRoles(): Store {
  return new Map<string, Row[]>([
    [
      "roles",
      STARTER_SLUGS.map((slug, index) => ({
        id: index + 1,
        orgId: ORG_B,
        slug,
        name: slug,
        isSystem: false,
      })),
    ],
  ]);
}

function storeWithForeignAdminMembership(): Store {
  return new Map<string, Row[]>([
    ["roles", [{ id: 1, orgId: ORG_B, slug: "SALES_REP", name: "Sales Rep", isSystem: false }]],
    [
      "organization_members",
      [
        { id: 1, orgId: ORG_B, userId: "user-a", status: "ACTIVE", isOwner: false, role: "ORG_ADMIN" },
        { id: 2, orgId: ORG_A, userId: "user-a", status: "ACTIVE", isOwner: false, role: "MEMBER" },
      ],
    ],
  ]);
}

function storeWithLocalAdminMembership(): Store {
  const store = storeWithForeignAdminMembership();
  store.set("organization_members", [
    { id: 2, orgId: ORG_A, userId: "user-a", status: "ACTIVE", isOwner: false, role: "ORG_ADMIN" },
  ]);
  return store;
}

function actorInOrgA(): CurrentUserContext {
  return {
    userId: "user-a",
    orgId: ORG_A,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-a",
    tokenScopes: null,
    principal: humanSessionPrincipal(42, false),
  };
}

async function capture(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

function rolesOf(store: Store, orgId: string): Row[] {
  return (store.get("roles") ?? []).filter((row) => row.orgId === orgId);
}

describe("RoleSeedService — cross-tenant isolation", () => {
  const actor = actorInOrgA();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("probes with a non-owner actor carrying a membership id", () => {
    expect(actor.isOrgOwner).toBe(false);
    expect(principalIsOrgOwner(actor.principal)).toBe(false);
    expect(actingMembershipId(actor.principal)).toBe(42);
  });

  describe("seedDefaultRoles", () => {
    it("seeds org A's own starter roles although org B already holds every slug", async () => {
      const { db, store, transactionCallbackRuns } = makeHarness(storeWithOrgBStarterRoles());
      const service = new RoleSeedService(db);

      const result = await service.seedDefaultRoles(ORG_A);

      expect(result.skipped).toEqual([]);
      expect(result.created).toHaveLength(6);
      expect(transactionCallbackRuns()).toBeGreaterThan(0);
      expect(seedSystemRolesForOrg).toHaveBeenCalledWith(db, ORG_A);

      const seeded = rolesOf(store, ORG_A);
      expect(seeded).toHaveLength(6);
      expect(rolesOf(store, ORG_B)).toHaveLength(6);
      for (const grant of store.get("role_permission_grants") ?? [])
        expect(grant.orgId).toBe(ORG_A);
      for (const version of store.get("access_versions") ?? []) expect(version.orgId).toBe(ORG_A);
    });

    it("BITE — neutering the tenant predicate makes org B's roles suppress org A's seed", async () => {
      const { db, store } = makeHarness(storeWithOrgBStarterRoles(), true);
      const service = new RoleSeedService(db);

      const result = await service.seedDefaultRoles(ORG_A);

      expect(result.created).toEqual([]);
      expect(result.skipped).toHaveLength(6);
      expect(rolesOf(store, ORG_A)).toHaveLength(0);
    });
  });

  describe("materializeTemplate", () => {
    it("refuses a non-owner member of org A whose ORG_ADMIN standing lives in org B", async () => {
      const { db, store } = makeHarness(storeWithForeignAdminMembership());
      const service = new RoleSeedService(db);

      const error = await capture(() => service.materializeTemplate(actor, "sales_rep"));

      expect(error).toBeInstanceOf(ForbiddenException);
      if (error instanceof ForbiddenException) expect(error.getStatus()).toBe(403);
      expect(rolesOf(store, ORG_A)).toHaveLength(0);
    });

    it("BITE — neutering the tenant predicate lets org B's ORG_ADMIN row authorize in org A", async () => {
      const { db } = makeHarness(storeWithForeignAdminMembership(), true);
      const service = new RoleSeedService(db);

      await expect(service.materializeTemplate(actor, "sales_rep")).resolves.toBeDefined();
    });

    it("returns org A's own role, never org B's row carrying the same slug", async () => {
      const { db, store, transactionCallbackRuns } = makeHarness(storeWithLocalAdminMembership());
      const service = new RoleSeedService(db);

      const created = await service.materializeTemplate(actor, "sales_rep");

      expect(created.orgId).toBe(ORG_A);
      expect(created.id).not.toBe(1);
      expect(created.slug).toBe("SALES_REP");
      expect(transactionCallbackRuns()).toBeGreaterThan(0);
      expect(rolesOf(store, ORG_B)).toHaveLength(1);
      for (const grant of store.get("role_permission_grants") ?? [])
        expect(grant.orgId).toBe(ORG_A);
    });

    it("BITE — neutering the tenant predicate hands org B's role to an org A actor", async () => {
      const { db, store } = makeHarness(storeWithLocalAdminMembership(), true);
      const service = new RoleSeedService(db);

      const leaked = await service.materializeTemplate(actor, "sales_rep");

      expect(leaked.orgId).toBe(ORG_B);
      expect(leaked.id).toBe(1);
      expect(rolesOf(store, ORG_A)).toHaveLength(0);
    });

    it("answers an unresolvable template with 404, never 403", async () => {
      const { db } = makeHarness(storeWithLocalAdminMembership());
      const service = new RoleSeedService(db);

      const error = await capture(() => service.materializeTemplate(actor, "no_such_template"));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error).not.toBeInstanceOf(ForbiddenException);
      if (error instanceof NotFoundException) expect(error.getStatus()).toBe(404);
    });
  });
});
