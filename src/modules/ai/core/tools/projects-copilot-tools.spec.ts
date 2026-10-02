import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ProjectsCopilotTools } from "./projects-copilot-tools";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import { ScopedRead } from "../../../access/scoped-read";
import type { AskOsActor } from "../services/ask-os-actor";
import type { AskOsToolRunContext } from "../registry/ask-os-tool.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";

const CALLER_C5: CurrentUserContext = {
  userId: "user-c5",
  orgId: "org-c5",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-c5",
  tokenScopes: null,
  principal: humanSessionPrincipal(42, false),
};

const ACTOR_C5: AskOsActor = {
  userId: "user-c5",
  orgId: "org-c5",
  membershipId: 42,
  displayName: "C5 User",
  email: "c5@example.com",
  orgName: "C5 Org",
  role: "MEMBER",
  isOrgOwner: false,
  timezone: "UTC",
  today: "2026-10-01",
  monthStart: "2026-10-01",
  monthEnd: "2026-10-31",
  currentYear: 2026,
  currentMonth: 10,
};

function makeAllCtx(): AskOsToolRunContext {
  const read = ScopedRead.of(ACTOR_C5.orgId, ACTOR_C5.userId, "all");
  const memberReadFor = (key: string) =>
    ScopedRead.of(ACTOR_C5.orgId, ACTOR_C5.userId, key === "build:manage" ? "none" : key === "build:view" ? "own" : "all");
  return { actor: ACTOR_C5, caller: CALLER_C5, read, readFor: memberReadFor, modules: {} };
}

function makeOrgAdminCtx(): AskOsToolRunContext {
  const read = ScopedRead.of(ACTOR_C5.orgId, ACTOR_C5.userId, "all");
  return { actor: ACTOR_C5, caller: CALLER_C5, read, readFor: () => read, modules: {} };
}

function buildCaptureDb() {
  const capturedWhereArgs: unknown[] = [];
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn((arg: unknown) => {
          capturedWhereArgs.push(arg);
          return { limit: jest.fn().mockResolvedValue([]) };
        }),
      }),
    }),
  };
  return { db, capturedWhereArgs };
}

function assertReachabilityPredicate(whereArg: unknown, membershipId: number): void {
  if (!(whereArg instanceof SQL)) throw new Error("expected a drizzle SQL from .where()");
  const { sql: sqlText, params } = new PgDialect().sqlToQuery(whereArg);
  expect(sqlText).toContain('"project_id" IN (SELECT');
  expect(params).toContain(membershipId);
}

describe("C5/C6: ticket queries apply project reachability predicate", () => {
  it("readTicket gives a build:manage=all holder every project, matching the HTTP project-access decision, while still binding the tenant", async () => {
    const { db, capturedWhereArgs } = buildCaptureDb();
    const svc = new ProjectsCopilotTools(db as never, {} as never);
    const tool = svc.tools().find((d) => d.key === "readTicket")!;

    await tool.run({ ticketId: 99 }, makeOrgAdminCtx());

    const whereArg = capturedWhereArgs[0];
    if (!(whereArg instanceof SQL)) throw new Error("expected a drizzle SQL from .where()");
    const { sql: sqlText, params } = new PgDialect().sqlToQuery(whereArg);
    expect(sqlText).not.toContain("project_members");
    expect(params).toContain(ACTOR_C5.orgId);
  });

  it("readTicket all-scoped WHERE contains project_id IN subquery, blocking org-wide ticket title enumeration by numeric id", async () => {
    expect.hasAssertions();
    const { db, capturedWhereArgs } = buildCaptureDb();
    const svc = new ProjectsCopilotTools(db as never, {} as never);
    const tool = svc.tools().find((d) => d.key === "readTicket")!;

    await tool.run({ ticketId: 99 }, makeAllCtx());

    assertReachabilityPredicate(capturedWhereArgs[0], ACTOR_C5.membershipId);
  });

  it("readTicket returns empty when query matches nothing, so the absence of a result is indistinguishable from a scoped denial", async () => {
    expect.hasAssertions();
    const { db } = buildCaptureDb();
    const svc = new ProjectsCopilotTools(db as never, {} as never);
    const tool = svc.tools().find((d) => d.key === "readTicket")!;

    const result = await tool.run({ ticketId: 99 }, makeAllCtx());

    expect(result).toMatchObject({ kind: "empty" });
  });

  it("searchTickets all-scoped WHERE contains project_id IN subquery, blocking org-wide title enumeration by keyword search", async () => {
    expect.hasAssertions();
    const { db, capturedWhereArgs } = buildCaptureDb();
    const svc = new ProjectsCopilotTools(db as never, {} as never);
    const tool = svc.tools().find((d) => d.key === "searchTickets")!;

    await tool.run({ query: "alpha", limit: 5 }, makeAllCtx());

    assertReachabilityPredicate(capturedWhereArgs[0], ACTOR_C5.membershipId);
  });

  it("searchTickets returns empty when query matches nothing, consistent with a member who has reached project scope", async () => {
    expect.hasAssertions();
    const { db } = buildCaptureDb();
    const svc = new ProjectsCopilotTools(db as never, {} as never);
    const tool = svc.tools().find((d) => d.key === "searchTickets")!;

    const result = await tool.run({ query: "alpha", limit: 5 }, makeAllCtx());

    expect(result).toMatchObject({ kind: "data" });
  });

  it("updateTicketStatus existence check WHERE contains project_id IN subquery, preventing ticket title leaking into the confirmation preview", async () => {
    expect.hasAssertions();
    const { db, capturedWhereArgs } = buildCaptureDb();
    const svc = new ProjectsCopilotTools(db as never, {} as never);
    const tool = svc.tools().find((d) => d.key === "updateTicketStatus")!;

    await tool.run({ ticketId: 99, status: "DONE" }, makeAllCtx());

    assertReachabilityPredicate(capturedWhereArgs[0], ACTOR_C5.membershipId);
  });

  it("updateTicketStatus returns empty when ticket is outside reachable projects, so the title never surfaces in the confirmation card", async () => {
    expect.hasAssertions();
    const { db } = buildCaptureDb();
    const svc = new ProjectsCopilotTools(db as never, {} as never);
    const tool = svc.tools().find((d) => d.key === "updateTicketStatus")!;

    const result = await tool.run({ ticketId: 99, status: "DONE" }, makeAllCtx());

    expect(result).toMatchObject({ kind: "empty" });
  });

  it("addTicketComment existence check WHERE contains project_id IN subquery, preventing ticket title leaking into the confirmation preview", async () => {
    expect.hasAssertions();
    const { db, capturedWhereArgs } = buildCaptureDb();
    const svc = new ProjectsCopilotTools(db as never, {} as never);
    const tool = svc.tools().find((d) => d.key === "addTicketComment")!;

    await tool.run({ ticketId: 99, comment: "hello" }, makeAllCtx());

    assertReachabilityPredicate(capturedWhereArgs[0], ACTOR_C5.membershipId);
  });

  it("addTicketComment returns empty when ticket is outside reachable projects, so the title never surfaces in the confirmation card", async () => {
    expect.hasAssertions();
    const { db } = buildCaptureDb();
    const svc = new ProjectsCopilotTools(db as never, {} as never);
    const tool = svc.tools().find((d) => d.key === "addTicketComment")!;

    const result = await tool.run({ ticketId: 99, comment: "hello" }, makeAllCtx());

    expect(result).toMatchObject({ kind: "empty" });
  });
});

describe("ProjectsCopilotTools — createTicket input schema", () => {
  let svc: ProjectsCopilotTools;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        ProjectsCopilotTools,
        { provide: DRIZZLE, useValue: {} },
        { provide: AiConfirmationService, useValue: {} },
      ],
    }).compile();
    svc = mod.get(ProjectsCopilotTools);
  });

  it("accepts every value in the DB ticket_type enum", () => {
    const tool = svc.tools().find((t) => t.key === "createTicket");
    expect(tool).toBeDefined();
    for (const type of ["TASK", "STORY", "BUG", "EPIC"]) {
      const result = tool!.input.safeParse({ projectId: 1, title: "Test ticket", type });
      expect(result.success).toBe(true);
    }
  });

  it("rejects SUBTASK which is absent from the DB ticket_type enum", () => {
    const tool = svc.tools().find((t) => t.key === "createTicket");
    expect(tool).toBeDefined();
    const result = tool!.input.safeParse({ projectId: 1, title: "Test ticket", type: "SUBTASK" });
    expect(result.success).toBe(false);
  });
});
