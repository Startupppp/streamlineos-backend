import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { CrmCopilotTools } from "./crm-copilot-tools";
import { isToolAvailable } from "./registry/ask-os-tool-registry";
import type { AskOsActor } from "./services/ask-os-actor";
import type { AskOsToolRunContext, AskOsToolDefinition } from "./registry/ask-os-tool.types";
import type { AccessSnapshot } from "../../access/access.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG = "org-crm-1";
const ACTOR_USER = "user-rep-1";
const OTHER_USER = "user-rep-2";

function makeAskOsActor(userId: string): AskOsActor {
  return {
    userId,
    orgId: ORG,
    membershipId: 1,
    displayName: "Test Rep",
    email: "rep@example.com",
    orgName: "Test Org",
    role: "MEMBER",
    isOrgOwner: false,
    timezone: "UTC",
    today: "2026-01-01",
    monthStart: "2026-01-01",
    monthEnd: "2026-01-31",
    currentYear: 2026,
    currentMonth: 1,
  };
}

function makeCaller(userId: string): CurrentUserContext {
  return {
    userId,
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-test",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function makeCtx(scope: "all" | "own" | "team" | "none", userId: string = ACTOR_USER): AskOsToolRunContext {
  return {
    actor: makeAskOsActor(userId),
    caller: makeCaller(userId),
    scope,
    scopes: {},
    modules: {},
  };
}

function makeSnapshot(scopes: Record<string, "all" | "own" | "team" | "none">): AccessSnapshot {
  return {
    membershipId: 1,
    scopes,
    modules: {},
    isOrgOwner: false,
    canManageOrganizationMembership: false,
    mfa: { enforced: false, satisfied: true },
    version: 1,
  };
}

interface CaptureDb {
  db: Db;
  capturedWheres: SQL[];
}

function captureDb(): CaptureDb {
  const capturedWheres: SQL[] = [];
  const chain: Record<string, unknown> = {};
  chain.from = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.where = jest.fn((cond: SQL) => {
    capturedWheres.push(cond);
    return chain;
  });
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve([]));
  const db = { select: jest.fn(() => chain) } as unknown as Db;
  return { db, capturedWheres };
}

function renderSql(statement: SQL): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(statement);
}

function findTool(defs: AskOsToolDefinition[], key: string): AskOsToolDefinition {
  const def = defs.find((d) => d.key === key);
  if (!def) throw new Error(`Tool "${key}" not in tools()`);
  return def;
}

describe("CrmCopilotTools — D-03 soft-delete and DataScope fixes", () => {
  describe("searchLeads", () => {
    it("(a) excludes soft-deleted leads: deleted_at IS NULL is in the predicate", async () => {
      const { db, capturedWheres } = captureDb();
      const defs = new CrmCopilotTools(db).tools();
      const searchLeads = findTool(defs, "searchLeads");

      await searchLeads.run({ query: "acme", limit: 5 }, makeCtx("all"));

      expect(capturedWheres).toHaveLength(1);
      const { sql } = renderSql(capturedWheres[0] as SQL);
      expect(sql).toContain("deleted_at");
      expect(sql.toLowerCase()).toContain("is null");
    });

    it("(b) own-scoped actor: predicate binds actor userId on the owner column", async () => {
      const { db, capturedWheres } = captureDb();
      const defs = new CrmCopilotTools(db).tools();
      const searchLeads = findTool(defs, "searchLeads");

      await searchLeads.run({ query: "acme", limit: 5 }, makeCtx("own", ACTOR_USER));

      expect(capturedWheres).toHaveLength(1);
      const { sql, params } = renderSql(capturedWheres[0] as SQL);
      expect(sql).toContain("owner_user_id");
      expect(params).toContain(ACTOR_USER);
      expect(params).not.toContain(OTHER_USER);
    });

    it("(b) none-scoped actor is denied by the registry before run is called", () => {
      const { db } = captureDb();
      const defs = new CrmCopilotTools(db).tools();
      const searchLeads = findTool(defs, "searchLeads");

      expect(isToolAvailable(searchLeads, makeSnapshot({}))).toBe(false);
      expect(isToolAvailable(searchLeads, makeSnapshot({ "crm:leads:view": "none" }))).toBe(false);
      expect(isToolAvailable(searchLeads, makeSnapshot({ "crm:leads:view": "all" }))).toBe(true);
    });
  });

  describe("updateLeadStatus", () => {
    it("(a) excludes soft-deleted leads from lookup: deleted_at IS NULL is in the predicate", async () => {
      const { db, capturedWheres } = captureDb();
      const defs = new CrmCopilotTools(db).tools();
      const updateLeadStatus = findTool(defs, "updateLeadStatus");

      await updateLeadStatus.run({ leadIdentifier: "Acme Corp", status: "QUALIFIED" }, makeCtx("all"));

      expect(capturedWheres).toHaveLength(1);
      const { sql } = renderSql(capturedWheres[0] as SQL);
      expect(sql).toContain("deleted_at");
      expect(sql.toLowerCase()).toContain("is null");
    });

    it("(b) own-scoped actor: lookup predicate binds actor userId on the owner column", async () => {
      const { db, capturedWheres } = captureDb();
      const defs = new CrmCopilotTools(db).tools();
      const updateLeadStatus = findTool(defs, "updateLeadStatus");

      await updateLeadStatus.run({ leadIdentifier: "Acme Corp", status: "QUALIFIED" }, makeCtx("own", ACTOR_USER));

      expect(capturedWheres).toHaveLength(1);
      const { sql, params } = renderSql(capturedWheres[0] as SQL);
      expect(sql).toContain("owner_user_id");
      expect(params).toContain(ACTOR_USER);
      expect(params).not.toContain(OTHER_USER);
    });

    it("(b) none-scoped actor is denied by the registry before run is called", () => {
      const { db } = captureDb();
      const defs = new CrmCopilotTools(db).tools();
      const updateLeadStatus = findTool(defs, "updateLeadStatus");

      expect(isToolAvailable(updateLeadStatus, makeSnapshot({}))).toBe(false);
      expect(isToolAvailable(updateLeadStatus, makeSnapshot({ "crm:leads:update": "none" }))).toBe(false);
      expect(isToolAvailable(updateLeadStatus, makeSnapshot({ "crm:leads:update": "all" }))).toBe(true);
    });
  });
});
