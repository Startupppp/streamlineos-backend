jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { AppConfig } from "../../../config/env.validation";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { agentTokenPrincipal, humanSessionPrincipal } from "../../../common/auth/principal";
import type { ComposioGateway } from "./composio.gateway";
import { orgComposioUserId } from "./connection-resolution";
import { OrgConnectionsService } from "./org-connections.service";

const dialect = new PgDialect();

const MINE = "org-mine";
const CONFIG = { APP_URL: "https://app.example.com" } as AppConfig;
const INCUMBENT = "ca_incumbent";
const REPLACEMENT = "ca_replacement";

function actor(
  role: string,
  overrides: Partial<CurrentUserContext> = {},
): CurrentUserContext {
  return {
    userId: "user-admin",
    orgId: MINE,
    role,
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, false),
    ...overrides,
  };
}

const MEMBER = actor("MEMBER");
const ORG_ADMIN = actor("ORG_ADMIN");

function savedRow(composioConnectedAccountId: string) {
  return {
    id: 12,
    status: "active" as const,
    toolkit: "googlecalendar" as const,
    isPrimary: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    accountEmail: "meet@acme.test",
    accountLabel: "meet@acme.test",
    composioConnectedAccountId,
  };
}

function boundValues(where: SQL | undefined): { text: string; params: unknown[] } {
  if (!where) throw new Error("predicate was undefined");
  const { sql: text, params } = dialect.sqlToQuery(where);
  return { text, params };
}

type Recorder = {
  predicates: (SQL | undefined)[];
  inserted: Record<string, unknown>[];
};

type DbOptions = {
  member?: { isOwner: boolean; role: string } | undefined;
  deleteReturns?: { composioConnectedAccountId: string }[];
  insertReturns?: ReturnType<typeof savedRow>[];
  transactionRejects?: unknown;
};

function buildDb(options: DbOptions): { db: Db; recorder: Recorder } {
  const recorder: Recorder = { predicates: [], inserted: [] };
  const deleteReturns = options.deleteReturns ?? [];
  const insertReturns = options.insertReturns ?? [savedRow(REPLACEMENT)];

  const deleteBuilder = {
    where: (where: SQL | undefined) => {
      recorder.predicates.push(where);
      return { returning: () => Promise.resolve(deleteReturns) };
    },
  };

  const insertBuilder = {
    values: (row: Record<string, unknown>) => {
      recorder.inserted.push(row);
      return {
        onConflictDoUpdate: () => ({ returning: () => Promise.resolve(insertReturns) }),
      };
    },
  };

  const tx = { delete: () => deleteBuilder, insert: () => insertBuilder };

  const db = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(options.member),
      },
    },
    select: jest.fn().mockReturnValue({
      from: () => ({
        where: (where: SQL | undefined) => {
          recorder.predicates.push(where);
          return { orderBy: () => ({ limit: () => Promise.resolve([]) }) };
        },
      }),
    }),
    delete: () => deleteBuilder,
    transaction: jest.fn().mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => {
      if (options.transactionRejects !== undefined) throw options.transactionRejects;
      return fn(tx);
    }),
  } as unknown as Db;

  return { db, recorder };
}

function buildGateway(overrides: Partial<Record<keyof ComposioGateway, unknown>> = {}) {
  return {
    initiateConnection: jest
      .fn()
      .mockResolvedValue({ redirectUrl: "https://composio/redirect" }),
    getOwnedConnectedAccount: jest.fn().mockResolvedValue({
      id: REPLACEMENT,
      status: "ACTIVE",
      userId: orgComposioUserId(MINE),
      toolkitSlug: "googlecalendar",
      email: "meet@acme.test",
    }),
    getAccountEmail: jest.fn().mockResolvedValue("meet@acme.test"),
    deleteConnectedAccount: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ComposioGateway;
}

describe("OrgConnectionsService — only genuine org-admin standing opens the org scope", () => {
  it("refuses an ordinary member who holds integrations:connections:manage", async () => {
    const { db } = buildDb({ member: { isOwner: false, role: "MEMBER" } });
    const gateway = buildGateway();
    const service = new OrgConnectionsService(db, CONFIG, gateway);

    await expect(service.initiate(MEMBER, "googlecalendar")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.finalize(MEMBER, REPLACEMENT)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.disconnect(MEMBER, 12)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.list(MEMBER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(gateway.initiateConnection).not.toHaveBeenCalled();
    expect(gateway.getOwnedConnectedAccount).not.toHaveBeenCalled();
  });

  it("refuses a member whose membership row is absent", async () => {
    const { db } = buildDb({ member: undefined });
    const service = new OrgConnectionsService(db, CONFIG, buildGateway());

    await expect(service.initiate(MEMBER, "googlecalendar")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("refuses an agent token issued by an org admin", async () => {
    const { db } = buildDb({ member: { isOwner: false, role: "ORG_ADMIN" } });
    const service = new OrgConnectionsService(db, CONFIG, buildGateway());
    const machine = actor("ORG_ADMIN", { principal: agentTokenPrincipal(7, 3, []) });

    await expect(service.initiate(machine, "googlecalendar")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("lets an org admin start the connection under the organisation's Composio principal", async () => {
    const { db } = buildDb({ member: { isOwner: false, role: "ORG_ADMIN" } });
    const gateway = buildGateway();
    const service = new OrgConnectionsService(db, CONFIG, gateway);

    const result = await service.initiate(ORG_ADMIN, "googlecalendar");

    expect(result.redirectUrl).toBe("https://composio/redirect");
    expect(gateway.initiateConnection).toHaveBeenCalledWith(
      orgComposioUserId(MINE),
      "googlecalendar",
      "https://app.example.com/calendar",
    );
  });

  it("lets the org owner through without an ORG_ADMIN role row", async () => {
    const { db } = buildDb({ member: { isOwner: false, role: "MEMBER" } });
    const gateway = buildGateway();
    const service = new OrgConnectionsService(db, CONFIG, gateway);

    await service.initiate(actor("MEMBER", { isOrgOwner: true }), "googlecalendar");

    expect(gateway.initiateConnection).toHaveBeenCalled();
  });
});

describe("OrgConnectionsService.finalize — adoption, replacement and conflict", () => {
  it("refuses an account that was not linked under the organisation's principal", async () => {
    const { db } = buildDb({ member: { isOwner: false, role: "ORG_ADMIN" } });
    const gateway = buildGateway({
      getOwnedConnectedAccount: jest.fn().mockResolvedValue(null),
    });
    const service = new OrgConnectionsService(db, CONFIG, gateway);

    await expect(service.finalize(ORG_ADMIN, "ca_personal")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(gateway.getOwnedConnectedAccount).toHaveBeenCalledWith(
      orgComposioUserId(MINE),
      "ca_personal",
    );
  });

  it("replaces the incumbent org connection and forgets it at Composio", async () => {
    const { db, recorder } = buildDb({
      member: { isOwner: false, role: "ORG_ADMIN" },
      deleteReturns: [{ composioConnectedAccountId: INCUMBENT }],
    });
    const gateway = buildGateway();
    const service = new OrgConnectionsService(db, CONFIG, gateway);

    const row = await service.finalize(ORG_ADMIN, REPLACEMENT);

    expect(row).toMatchObject({ id: 12, toolkit: "googlecalendar" });
    expect(gateway.deleteConnectedAccount).toHaveBeenCalledWith(INCUMBENT);
    expect(recorder.inserted[0]).toMatchObject({
      orgId: MINE,
      scope: "org",
      membershipId: null,
      userId: orgComposioUserId(MINE),
      composioConnectedAccountId: REPLACEMENT,
    });
  });

  it("stores no membership and no member's user id, so a departure cannot take it", async () => {
    const { db, recorder } = buildDb({ member: { isOwner: false, role: "ORG_ADMIN" } });
    const service = new OrgConnectionsService(db, CONFIG, buildGateway());

    await service.finalize(ORG_ADMIN, REPLACEMENT);

    const inserted = recorder.inserted[0];
    expect(inserted?.membershipId).toBeNull();
    expect(inserted?.userId).not.toBe(ORG_ADMIN.userId);
  });

  it("supersedes only the other org rows for the same toolkit in the same tenant", async () => {
    const { db, recorder } = buildDb({ member: { isOwner: false, role: "ORG_ADMIN" } });
    const service = new OrgConnectionsService(db, CONFIG, buildGateway());

    await service.finalize(ORG_ADMIN, REPLACEMENT);

    const { text, params } = boundValues(recorder.predicates[0]);
    expect(text).toMatch(/"user_integration_connections"\."org_id"\s*=\s*\$/i);
    expect(text).toMatch(/"user_integration_connections"\."scope"\s*=\s*\$/i);
    expect(text).toMatch(/"user_integration_connections"\."toolkit"\s*=\s*\$/i);
    expect(text).toMatch(
      /"user_integration_connections"\."composio_connected_account_id"\s*<>\s*\$/i,
    );
    expect(params).toEqual(expect.arrayContaining([MINE, "org", "googlecalendar", REPLACEMENT]));
  });

  it("answers 409 when a concurrent finalize already took the toolkit slot", async () => {
    const { db } = buildDb({
      member: { isOwner: false, role: "ORG_ADMIN" },
      transactionRejects: { code: "23505" },
    });
    const service = new OrgConnectionsService(db, CONFIG, buildGateway());

    await expect(service.finalize(ORG_ADMIN, REPLACEMENT)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("does not swallow an unrelated database failure as a conflict", async () => {
    const { db } = buildDb({
      member: { isOwner: false, role: "ORG_ADMIN" },
      transactionRejects: Object.assign(new Error("connection reset"), { code: "08006" }),
    });
    const service = new OrgConnectionsService(db, CONFIG, buildGateway());

    await expect(service.finalize(ORG_ADMIN, REPLACEMENT)).rejects.toThrow("connection reset");
  });

  it("answers 409 when the connected account already belongs to another connection", async () => {
    const { db } = buildDb({
      member: { isOwner: false, role: "ORG_ADMIN" },
      insertReturns: [],
    });
    const service = new OrgConnectionsService(db, CONFIG, buildGateway());

    await expect(service.finalize(ORG_ADMIN, REPLACEMENT)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("OrgConnectionsService.disconnect — tenant and scope bound", () => {
  it("404s and deletes nothing at Composio when no org row matches", async () => {
    const { db } = buildDb({
      member: { isOwner: false, role: "ORG_ADMIN" },
      deleteReturns: [],
    });
    const gateway = buildGateway();
    const service = new OrgConnectionsService(db, CONFIG, gateway);

    await expect(service.disconnect(ORG_ADMIN, 999)).rejects.toBeInstanceOf(NotFoundException);
    expect(gateway.deleteConnectedAccount).not.toHaveBeenCalled();
  });

  it("binds the caller's org and the org scope, so another tenant's row is unreachable", async () => {
    const { db, recorder } = buildDb({
      member: { isOwner: false, role: "ORG_ADMIN" },
      deleteReturns: [{ composioConnectedAccountId: INCUMBENT }],
    });
    const service = new OrgConnectionsService(db, CONFIG, buildGateway());

    await service.disconnect(ORG_ADMIN, 12);

    const { text, params } = boundValues(recorder.predicates[0]);
    expect(text).toMatch(/"user_integration_connections"\."org_id"\s*=\s*\$/i);
    expect(params).toEqual(expect.arrayContaining([MINE, "org", 12]));
  });
});
