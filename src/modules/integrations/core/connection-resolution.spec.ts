jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import type {
  IntegrationConnectionScope,
  IntegrationConnectionStatus,
  IntegrationToolkit,
} from "../../../db/schema";
import { connectionOwnerPredicate } from "./connection-owner.predicate";
import {
  orgComposioUserId,
  resolveToolkitConnection,
  type ToolkitConnectionSubject,
} from "./connection-resolution";

const dialect = new PgDialect();

const MINE = "org-mine";
const OTHER = "org-other";
const ME = "user-me";
const MY_MEMBERSHIP = 41;

type StoredConnection = {
  id: number;
  orgId: string;
  userId: string;
  membershipId: number | null;
  toolkit: IntegrationToolkit;
  scope: IntegrationConnectionScope;
  status: IntegrationConnectionStatus;
  isPrimary: boolean;
  createdAt: Date;
  composioConnectedAccountId: string;
  accountEmail: string | null;
};

let nextId = 1;

function connection(overrides: Partial<StoredConnection> = {}): StoredConnection {
  const id = nextId++;
  return {
    id,
    orgId: MINE,
    userId: ME,
    membershipId: MY_MEMBERSHIP,
    toolkit: "googlecalendar",
    scope: "user",
    status: "active",
    isPrimary: false,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, id)),
    composioConnectedAccountId: `ca_${id}`,
    accountEmail: `account-${id}@example.com`,
    ...overrides,
  };
}

function orgConnection(overrides: Partial<StoredConnection> = {}): StoredConnection {
  return connection({
    scope: "org",
    membershipId: null,
    userId: orgComposioUserId(overrides.orgId ?? MINE),
    ...overrides,
  });
}

type BoundPredicate = {
  orgId: string;
  toolkit: string;
  excludedStatus: string;
  scopes: string[];
};

function boundPredicate(where: SQL): BoundPredicate {
  const { sql: text, params } = dialect.sqlToQuery(where);
  const readString = (pattern: RegExp, label: string): string => {
    const match = pattern.exec(text);
    if (!match) throw new Error(`read is not ${label}-bound: ${text}`);
    const value = params[Number(match[1]) - 1];
    if (typeof value !== "string")
      throw new Error(`${label} parameter was ${typeof value}: ${text}`);
    return value;
  };
  const scopes: string[] = [];
  const scopePattern = /"user_integration_connections"\."scope"\s*=\s*\$(\d+)/gi;
  for (const match of text.matchAll(scopePattern)) {
    const value = params[Number(match[1]) - 1];
    if (typeof value === "string") scopes.push(value);
  }
  return {
    orgId: readString(/"user_integration_connections"\."org_id"\s*=\s*\$(\d+)/i, "tenant"),
    toolkit: readString(/"user_integration_connections"\."toolkit"\s*=\s*\$(\d+)/i, "toolkit"),
    excludedStatus: readString(
      /"user_integration_connections"\."status"\s*<>\s*\$(\d+)/i,
      "status-exclusion",
    ),
    scopes,
  };
}

function matchesOwner(row: StoredConnection, subject: ToolkitConnectionSubject): boolean {
  if (subject.membershipId != null)
    return (
      row.membershipId === subject.membershipId ||
      (row.membershipId === null && row.userId === subject.userId)
    );
  return row.userId === subject.userId;
}

function buildDb(store: StoredConnection[], subject: ToolkitConnectionSubject): Db {
  const applyWhere = (where: SQL) => {
    const bound = boundPredicate(where);
    const rows = store
      .filter((row) => row.orgId === bound.orgId)
      .filter((row) => row.toolkit === bound.toolkit)
      .filter((row) => row.status !== bound.excludedStatus)
      .filter((row) =>
        row.scope === "org"
          ? bound.scopes.includes("org")
          : bound.scopes.includes("user") && matchesOwner(row, subject),
      )
      .sort(
        (a, b) =>
          Number(b.isPrimary) - Number(a.isPrimary) ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
    return {
      orderBy: () => ({
        limit: (take: number) =>
          Promise.resolve(
            rows.slice(0, take).map((row) => ({
              connectionId: row.id,
              composioConnectedAccountId: row.composioConnectedAccountId,
              composioUserId: row.userId,
              scope: row.scope,
              status: row.status,
              accountEmail: row.accountEmail,
            })),
          ),
      }),
    };
  };
  return {
    select: jest.fn().mockReturnValue({ from: () => ({ where: applyWhere }) }),
  } as unknown as Db;
}

function subjectFor(orgId: string): ToolkitConnectionSubject {
  return { orgId, userId: ME, membershipId: MY_MEMBERSHIP, toolkit: "googlecalendar" };
}

async function resolve(
  store: StoredConnection[],
  orgId = MINE,
): ReturnType<typeof resolveToolkitConnection> {
  const subject = subjectFor(orgId);
  return resolveToolkitConnection(buildDb(store, subject), subject);
}

beforeEach(() => {
  nextId = 1;
});

describe("resolveToolkitConnection — which account this org uses for a toolkit", () => {
  it("prefers the caller's own active connection over the org-scoped one", async () => {
    const own = connection();
    const shared = orgConnection();

    const result = await resolve([shared, own]);

    expect(result).toEqual({
      status: "resolved",
      connection: {
        connectionId: own.id,
        composioConnectedAccountId: own.composioConnectedAccountId,
        composioUserId: ME,
        scope: "user",
        accountEmail: own.accountEmail,
      },
    });
  });

  it("falls back to the org-scoped connection when the caller has none of their own", async () => {
    const shared = orgConnection();

    const result = await resolve([shared]);

    expect(result).toMatchObject({
      status: "resolved",
      connection: { connectionId: shared.id, scope: "org" },
    });
  });

  it("falls back to the org-scoped connection when the caller's own needs reauth", async () => {
    const own = connection({ status: "needs_reauth" });
    const shared = orgConnection();

    const result = await resolve([own, shared]);

    expect(result).toMatchObject({
      status: "resolved",
      connection: { connectionId: shared.id, scope: "org" },
    });
  });

  it("carries the Composio principal the account was linked under, not the caller", async () => {
    const shared = orgConnection();

    const result = await resolve([shared]);

    expect(result).toMatchObject({
      status: "resolved",
      connection: { composioUserId: orgComposioUserId(MINE) },
    });
    expect(orgComposioUserId(MINE)).not.toBe(ME);
  });

  it("prefers the caller's primary connection among several of their own", async () => {
    const secondary = connection();
    const primary = connection({ isPrimary: true });

    const result = await resolve([secondary, primary]);

    expect(result).toMatchObject({
      status: "resolved",
      connection: { connectionId: primary.id },
    });
  });

  it("returns an unresolved value, not a throw, when the only connection needs reauth", async () => {
    const own = connection({ status: "needs_reauth" });

    const result = await resolve([own]);

    expect(result).toEqual({ status: "unresolved", reason: "needs-reauth" });
  });

  it("reports no-connection when the org has nothing for the toolkit", async () => {
    const result = await resolve([connection({ toolkit: "gmail" })]);

    expect(result).toEqual({ status: "unresolved", reason: "no-connection" });
  });

  it("never resolves a disabled org connection", async () => {
    const result = await resolve([orgConnection({ status: "disabled" })]);

    expect(result).toEqual({ status: "unresolved", reason: "no-connection" });
  });

  it("cannot reach another tenant's org-scoped connection", async () => {
    const foreign = orgConnection({ orgId: OTHER });

    const result = await resolve([foreign], MINE);

    expect(result).toEqual({ status: "unresolved", reason: "no-connection" });
    await expect(resolve([foreign], OTHER)).resolves.toMatchObject({
      status: "resolved",
      connection: { connectionId: foreign.id },
    });
  });

  it("cannot reach another member's personal connection", async () => {
    const someoneElse = connection({ userId: "user-other", membershipId: 99 });

    const result = await resolve([someoneElse]);

    expect(result).toEqual({ status: "unresolved", reason: "no-connection" });
  });
});

describe("connectionOwnerPredicate — personal ownership stops at scope = user", () => {
  const scopeValues = (where: SQL | undefined): unknown[] => {
    if (!where) throw new Error("predicate was undefined");
    const { sql: text, params } = dialect.sqlToQuery(where);
    return [
      ...text.matchAll(/"user_integration_connections"\."scope"\s*=\s*\$(\d+)/gi),
    ].map((match) => params[Number(match[1]) - 1]);
  };

  it("binds scope = user when the caller has a membership", () => {
    expect(scopeValues(connectionOwnerPredicate(ME, MY_MEMBERSHIP))).toEqual(["user"]);
  });

  it("binds scope = user on the legacy user_id fallback too", () => {
    expect(scopeValues(connectionOwnerPredicate(ME, null))).toEqual(["user"]);
  });
});
