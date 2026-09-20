import "reflect-metadata";

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T,>(_db: unknown, fn: () => Promise<T>) => fn(),
  runInNewTenantTransaction: <T,>(_db: unknown, _orgId: string, fn: () => Promise<T>) => fn(),
}));

import { Test } from "@nestjs/testing";
import { HrCopilotTools } from "./hr-copilot-tools";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AskOsActor } from "../services/ask-os-actor";
import type { AskOsToolRunContext } from "../registry/ask-os-tool.types";
import type { DataScope } from "../../../access/access.types";
import { ScopedRead } from "../../../access/scoped-read";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { humanSessionPrincipal } from "../../../../common/auth/principal";

const CALLER: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const ACTOR: AskOsActor = {
  userId: "user-1",
  orgId: "org-1",
  membershipId: 1,
  displayName: "Test User",
  email: "test@example.com",
  orgName: "Test Org",
  role: "MEMBER",
  isOrgOwner: false,
  timezone: "UTC",
  today: "2026-09-19",
  monthStart: "2026-09-01",
  monthEnd: "2026-09-30",
  currentYear: 2026,
  currentMonth: 9,
};

function makeCtx(scope: DataScope = "all"): AskOsToolRunContext {
  const read = ScopedRead.of(ACTOR.orgId, ACTOR.userId, scope);
  return {
    actor: ACTOR,
    caller: CALLER,
    read,
    readFor: () => read,
    modules: {},
  };
}

function renderExecutedSql(statement: unknown): string {
  if (!(statement instanceof SQL)) throw new Error("expected a drizzle SQL statement");
  return new PgDialect().sqlToQuery(statement).sql;
}

function extractSqlClauses(arg: unknown): string {
  if (typeof arg !== "object" || arg === null) return "";
  if (!("queryChunks" in arg)) return "";
  const chunks = arg.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk: unknown) => {
      if (typeof chunk !== "object" || chunk === null) return "";
      if ("queryChunks" in chunk) return extractSqlClauses(chunk);
      if (!("value" in chunk)) return "";
      const v = chunk.value;
      if (Array.isArray(v)) return v.filter((s: unknown) => typeof s === "string").join("");
      return typeof v === "string" ? v : "";
    })
    .join("");
}

async function buildSut() {
  const dbExecute = jest.fn().mockResolvedValue([]);
  const gatewayInvoke = jest.fn();

  const moduleRef = await Test.createTestingModule({
    providers: [
      HrCopilotTools,
      { provide: DRIZZLE, useValue: { execute: dbExecute } },
      { provide: AiGatewayService, useValue: { invokeText: gatewayInvoke } },
    ],
  }).compile();

  const sut = moduleRef.get(HrCopilotTools);
  const definitions = sut.tools();
  return { definitions, dbExecute, gatewayInvoke };
}

function findTool(definitions: ReturnType<HrCopilotTools["tools"]>, key: string) {
  const tool = definitions.find((d) => d.key === key);
  if (!tool) throw new Error(`Tool not found: ${key}`);
  return tool;
}

describe("HrCopilotTools — D-06: askHrPolicy excludes deleted and expired policies", () => {
  it("deleted policy not cited — SQL query includes deleted_at IS NULL predicate", async () => {
    expect.hasAssertions();
    const { definitions, dbExecute } = await buildSut();
    const tool = findTool(definitions, "askHrPolicy");

    await tool.run({ question: "leave policy?" }, makeCtx());

    const sqlText = extractSqlClauses(dbExecute.mock.calls[0]?.[0]);
    expect(sqlText).toContain("deleted_at IS NULL");
  });

  it("expired policy not cited — SQL query includes effective_to date window predicate", async () => {
    expect.hasAssertions();
    const { definitions, dbExecute } = await buildSut();
    const tool = findTool(definitions, "askHrPolicy");

    await tool.run({ question: "wfh policy?" }, makeCtx());

    const sqlText = extractSqlClauses(dbExecute.mock.calls[0]?.[0]);
    expect(sqlText).toContain("effective_from <= CURRENT_DATE");
    expect(sqlText).toContain("effective_to IS NULL OR effective_to >= CURRENT_DATE");
  });
});

describe("HrCopilotTools — F-06: gateway failure returns explicit error, no fabricated content", () => {
  it("gateway failure on draftPromotionLetter yields failed outcome with no fabricated letter body", async () => {
    expect.hasAssertions();
    const { definitions, dbExecute, gatewayInvoke } = await buildSut();
    const tool = findTool(definitions, "draftPromotionLetter");
    dbExecute.mockResolvedValue([{ first_name: "Alice", last_name: "Smith", designation: "Engineer" }]);
    gatewayInvoke.mockResolvedValue({ ok: false, kind: "provider_error" });

    const result = await tool.run(
      { employeeId: "emp-1", newTitle: "Senior Engineer", effectiveDate: "2026-10-01" },
      makeCtx(),
    );

    expect(result).toHaveProperty("kind", "failed");
    expect(result).not.toHaveProperty("draft");
  });

  it("quota_exceeded on draftPromotionLetter yields failed outcome, not a draft shape", async () => {
    expect.hasAssertions();
    const { definitions, dbExecute, gatewayInvoke } = await buildSut();
    const tool = findTool(definitions, "draftPromotionLetter");
    dbExecute.mockResolvedValue([{ first_name: "Bob", last_name: "Jones", designation: "Lead" }]);
    gatewayInvoke.mockResolvedValue({ ok: false, kind: "quota_exceeded" });

    const result = await tool.run(
      { employeeId: "emp-2", newTitle: "Staff Engineer", effectiveDate: "2026-10-01" },
      makeCtx(),
    );

    expect(result).toHaveProperty("kind", "failed");
    expect(result).not.toHaveProperty("draft");
  });

  it("gateway failure on draftPerformanceReviewNote yields failed outcome with no fabricated note body", async () => {
    expect.hasAssertions();
    const { definitions, dbExecute, gatewayInvoke } = await buildSut();
    const tool = findTool(definitions, "draftPerformanceReviewNote");
    dbExecute.mockResolvedValue([{ first_name: "Carol", last_name: "White" }]);
    gatewayInvoke.mockResolvedValue({ ok: false, kind: "provider_error" });

    const result = await tool.run(
      { employeeId: "emp-3", reviewPeriod: "Q3 2026" },
      makeCtx(),
    );

    expect(result).toHaveProperty("kind", "failed");
    expect(result).not.toHaveProperty("draft");
  });

  it("gateway failure on askHrPolicy yields failed outcome with no fabricated policy answer", async () => {
    expect.hasAssertions();
    const { definitions, dbExecute, gatewayInvoke } = await buildSut();
    const tool = findTool(definitions, "askHrPolicy");
    dbExecute.mockResolvedValue([{ id: 1, policy_type: "leave", status: "active", created_at: new Date() }]);
    gatewayInvoke.mockResolvedValue({ ok: false, kind: "provider_error" });

    const result = await tool.run({ question: "sick leave?" }, makeCtx());

    expect(result).toHaveProperty("kind", "failed");
    expect(result).not.toHaveProperty("answer");
  });
});

describe("HrCopilotTools — T-13.5: askHrPolicy policyCount is returned so the model knows if results were truncated", () => {
  it("includes policyCount with shown, fetched, and truncated fields when policies fit within the char cap", async () => {
    expect.hasAssertions();
    const { definitions, dbExecute, gatewayInvoke } = await buildSut();
    const tool = findTool(definitions, "askHrPolicy");
    dbExecute.mockResolvedValue([
      { id: 1, policy_type: "leave", name: "Leave Policy", description: "short", rules: null, status: "active", created_at: "2026-01-01" },
    ]);
    gatewayInvoke.mockResolvedValue({ ok: true, data: "Leave is 20 days." });

    const result = await tool.run({ question: "how much leave?" }, makeCtx("all"));

    expect(result).toMatchObject({
      kind: "data",
      data: { policyCount: { shown: 1, fetched: 1, truncated: false } },
    });
  });
});

describe("HrCopilotTools — T-20.4: getLeaveUtilization uses actor dates, not server wall-clock", () => {
  it("SQL params contain the actor today value so an actor in a future timezone sees today's leave correctly", async () => {
    expect.hasAssertions();
    const { definitions, dbExecute } = await buildSut();
    const tool = findTool(definitions, "getLeaveUtilization");
    const actorInFuture = { ...ACTOR, today: "2027-01-01", monthStart: "2027-01-01" };

    await tool.run({}, {
      actor: actorInFuture,
      caller: CALLER,
      read: ScopedRead.of(actorInFuture.orgId, actorInFuture.userId, "all"),
      readFor: () => ScopedRead.of(actorInFuture.orgId, actorInFuture.userId, "all"),
      modules: {},
    });

    const statement = dbExecute.mock.calls[0]?.[0];
    if (!(statement instanceof SQL)) throw new Error("expected SQL");
    const { params } = new PgDialect().sqlToQuery(statement);
    expect(params).toContain("2027-01-01");
  });

  it("asOf in the response matches the actor today, not the server wall-clock date", async () => {
    expect.hasAssertions();
    const { definitions, dbExecute } = await buildSut();
    const tool = findTool(definitions, "getLeaveUtilization");
    dbExecute.mockResolvedValue([{ currently_on_leave: "0", pending_requests: "0", approved_this_month: "0" }]);
    const actorInFuture = { ...ACTOR, today: "2027-06-15", monthStart: "2027-06-01" };

    const result = await tool.run({}, {
      actor: actorInFuture,
      caller: CALLER,
      read: ScopedRead.of(actorInFuture.orgId, actorInFuture.userId, "all"),
      readFor: () => ScopedRead.of(actorInFuture.orgId, actorInFuture.userId, "all"),
      modules: {},
    });

    expect(result).toMatchObject({ kind: "data", data: { asOf: "2027-06-15" } });
  });
});

describe("HrCopilotTools — T-20.4: getAttritionSummary SQL uses actor today for the 12-month window", () => {
  it("SQL params contain the actor today so an actor in a different timezone uses their correct reference date", async () => {
    expect.hasAssertions();
    const { definitions, dbExecute } = await buildSut();
    const tool = findTool(definitions, "getAttritionSummary");
    const actorInFuture = { ...ACTOR, today: "2027-03-15" };

    await tool.run({}, {
      actor: actorInFuture,
      caller: CALLER,
      read: ScopedRead.of(actorInFuture.orgId, actorInFuture.userId, "all"),
      readFor: () => ScopedRead.of(actorInFuture.orgId, actorInFuture.userId, "all"),
      modules: {},
    });

    const statement = dbExecute.mock.calls[0]?.[0];
    if (!(statement instanceof SQL)) throw new Error("expected SQL");
    const { sql: sqlText, params } = new PgDialect().sqlToQuery(statement);
    expect(params).toContain("2027-03-15");
    expect(sqlText).toContain("INTERVAL '12 months'");
  });
});

describe("HrCopilotTools — D-07: getLeaveUtilization scopes to caller when not org-wide", () => {
  it("own-scoped caller does not get org-wide leave volume — SQL includes user_id filter", async () => {
    expect.hasAssertions();
    const { definitions, dbExecute } = await buildSut();
    const tool = findTool(definitions, "getLeaveUtilization");

    await tool.run({}, makeCtx("own"));

    const sqlText = renderExecutedSql(dbExecute.mock.calls[0]?.[0]);
    expect(sqlText).toContain("user_id");
    expect(sqlText).toContain("org_id");
  });

  it("team scope stays as narrow as own, because leave has no team ownership edge", async () => {
    expect.hasAssertions();
    const { definitions, dbExecute } = await buildSut();
    const tool = findTool(definitions, "getLeaveUtilization");

    await tool.run({}, makeCtx("team"));

    expect(renderExecutedSql(dbExecute.mock.calls[0]?.[0])).toContain("user_id");
  });

  it("org-wide caller gets full org leave volume — SQL does not add user_id filter", async () => {
    expect.hasAssertions();
    const { definitions, dbExecute } = await buildSut();
    const tool = findTool(definitions, "getLeaveUtilization");

    await tool.run({}, makeCtx("all"));

    const sqlText = renderExecutedSql(dbExecute.mock.calls[0]?.[0]);
    expect(sqlText).not.toContain("user_id");
    expect(sqlText).toContain("org_id");
  });
});
