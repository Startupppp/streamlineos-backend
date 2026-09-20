import type { Db } from "../../../../db/drizzle.module";
import type { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import type { AskOsActor } from "../services/ask-os-actor";
import type { AskOsToolDefinition, AskOsToolRunContext } from "../registry/ask-os-tool.types";
import { ScopedRead } from "../../../access/scoped-read";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { WorkActionsTools } from "./work-actions-tools";

jest.mock("./lib/mail-connection", () => ({
  resolveAnyMailConnection: jest.fn(),
}));

jest.mock("../../../directory/person-seam", () => ({
  resolvePeopleByName: jest.fn(),
}));

import { resolveAnyMailConnection } from "./lib/mail-connection";
import { resolvePeopleByName } from "../../../directory/person-seam";

const MOCK_PROPOSAL = { proposalId: 1, token: "tok.epoch.hmac", expiresAt: new Date("2026-09-20T00:00:00Z") };

function makeActor(overrides: Partial<AskOsActor> = {}): AskOsActor {
  return {
    userId: "user-1",
    orgId: "org-1",
    membershipId: 10,
    displayName: "Alice",
    email: "alice@example.com",
    orgName: "Acme",
    role: "MEMBER",
    isOrgOwner: false,
    timezone: "America/New_York",
    today: "2026-09-19",
    monthStart: "2026-09-01",
    monthEnd: "2026-09-30",
    currentYear: 2026,
    currentMonth: 9,
    ...overrides,
  };
}

function makeCaller(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(10, false),
  };
}

function makeCtx(overrides: Partial<AskOsToolRunContext> = {}): AskOsToolRunContext {
  const actor = makeActor();
  const read = ScopedRead.of(actor.orgId, actor.userId, "all");
  return {
    actor,
    caller: makeCaller(),
    read,
    readFor: () => read,
    modules: {},
    ...overrides,
  };
}

function makeConfirmation(): AiConfirmationService {
  return {
    propose: jest.fn().mockResolvedValue(MOCK_PROPOSAL),
  } as unknown as AiConfirmationService;
}

function makeDbFluentChain(sequences: unknown[][]): Db {
  let callIndex = 0;

  function buildChain(results: unknown[]) {
    const limitFn = jest.fn().mockResolvedValue(results);
    const whereFn = jest.fn().mockReturnValue({ limit: limitFn });
    const innerJoinFn = jest.fn().mockReturnValue({ where: whereFn });
    const fromFn = jest.fn().mockReturnValue({ where: whereFn, innerJoin: innerJoinFn });
    return { from: fromFn };
  }

  return {
    select: jest.fn().mockImplementation(() => {
      const chain = buildChain(sequences[callIndex] ?? []);
      callIndex += 1;
      return chain;
    }),
  } as unknown as Db;
}

function findTool(tools: AskOsToolDefinition[], key: string): AskOsToolDefinition {
  const found = tools.find((t) => t.key === key);
  if (!found) throw new Error(`Tool "${key}" not found`);
  return found;
}

function makeInstance(dbSequences: unknown[][] = []): WorkActionsTools {
  return new WorkActionsTools(makeDbFluentChain(dbSequences), makeConfirmation());
}

describe("WorkActionsTools — schema invariants", () => {
  it("all tools have unique keys", () => {
    const tools = makeInstance().tools();
    const keys = tools.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("all tools declare a permission and module", () => {
    for (const tool of makeInstance().tools()) {
      expect(tool.permission).toBeDefined();
      expect(tool.module).toBeDefined();
    }
  });
});

describe("WorkActionsTools — createLead", () => {
  it("returns needs-confirmation and does not execute a write itself", async () => {
    const confirmation = makeConfirmation();
    const instance = new WorkActionsTools(makeDbFluentChain([]), confirmation);
    const tool = findTool(instance.tools(), "createLead");

    const outcome = await tool.run({ name: "Jane Doe", company: "Acme" }, makeCtx());

    expect(outcome.kind).toBe("needs-confirmation");
    expect(confirmation.propose).toHaveBeenCalledTimes(1);
    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "crm.createLead", orgId: "org-1", userId: "user-1" }),
    );
  });
});

describe("WorkActionsTools — logCrmActivity", () => {
  it("returns needs-confirmation and does not execute a write itself", async () => {
    const confirmation = makeConfirmation();
    const instance = new WorkActionsTools(
      makeDbFluentChain([[{ id: 42, name: "Jane Doe" }]]),
      confirmation,
    );
    const tool = findTool(instance.tools(), "logCrmActivity");

    const outcome = await tool.run(
      { leadIdentifier: "Jane", type: "call", notes: "Follow-up call completed" },
      makeCtx(),
    );

    expect(outcome.kind).toBe("needs-confirmation");
    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "crm.logActivity" }),
    );
  });
  it("resolves the lead to a numeric id before proposing, because the confirm handler rejects a name", async () => {
    const confirmation = makeConfirmation();
    const instance = new WorkActionsTools(
      makeDbFluentChain([[{ id: 42, name: "Jane Doe" }]]),
      confirmation,
    );
    const tool = findTool(instance.tools(), "logCrmActivity");

    await tool.run({ leadIdentifier: "Jane", type: "note", notes: "n" }, makeCtx());

    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "crm.logActivity",
        payload: expect.objectContaining({ leadIdentifier: 42 }),
      }),
    );
  });

  it("returns empty instead of proposing when no lead matches", async () => {
    const confirmation = makeConfirmation();
    const instance = new WorkActionsTools(makeDbFluentChain([[]]), confirmation);
    const tool = findTool(instance.tools(), "logCrmActivity");

    const outcome = await tool.run({ leadIdentifier: "Nobody", type: "note", notes: "n" }, makeCtx());

    expect(outcome.kind).toBe("empty");
    expect(confirmation.propose).not.toHaveBeenCalled();
  });

  it("reports the ambiguity rather than silently picking the first of several matching leads", async () => {
    const confirmation = makeConfirmation();
    const instance = new WorkActionsTools(
      makeDbFluentChain([[{ id: 1, name: "Acme North" }, { id: 2, name: "Acme South" }]]),
      confirmation,
    );
    const tool = findTool(instance.tools(), "logCrmActivity");

    const outcome = await tool.run({ leadIdentifier: "Acme", type: "note", notes: "n" }, makeCtx());

    expect(outcome.kind).toBe("empty");
    expect(confirmation.propose).not.toHaveBeenCalled();
  });

});

describe("WorkActionsTools — assignTicket", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns empty when no member matches the name", async () => {
    (resolvePeopleByName as jest.Mock).mockResolvedValue(
      new Map([["Nobody Known", { status: "unresolved" }]]),
    );
    const instance = makeInstance([[{ id: 42, title: "Fix bug" }]]);
    const tool = findTool(instance.tools(), "assignTicket");

    const outcome = await tool.run({ ticketId: 42, assigneeName: "Nobody Known" }, makeCtx());

    expect(outcome.kind).toBe("empty");
  });

  it("returns empty when the ticket is not found", async () => {
    const instance = makeInstance([[]]);
    const tool = findTool(instance.tools(), "assignTicket");

    const outcome = await tool.run({ ticketId: 99, assigneeName: "Bob" }, makeCtx());

    expect(outcome.kind).toBe("empty");
  });

  it("returns ambiguous outcome with typed candidates when multiple members share the name", async () => {
    (resolvePeopleByName as jest.Mock).mockResolvedValue(
      new Map([
        [
          "Bob",
          {
            status: "ambiguous",
            candidates: [
              { label: "Bob Smith", hint: "bob1@x.com" },
              { label: "Bob Jones", hint: "bob2@x.com" },
            ],
          },
        ],
      ]),
    );
    const instance = makeInstance([[{ id: 1, title: "Sprint task" }]]);
    const tool = findTool(instance.tools(), "assignTicket");

    const outcome = await tool.run({ ticketId: 1, assigneeName: "Bob" }, makeCtx());

    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind === "ambiguous") {
      expect(outcome.candidates.length).toBe(2);
      expect(outcome.candidates.map((c) => c.label)).toEqual(["Bob Smith", "Bob Jones"]);
    }
  });

  it("returns needs-confirmation and does not execute a write when exactly one member matches", async () => {
    const confirmation = makeConfirmation();
    (resolvePeopleByName as jest.Mock).mockResolvedValue(
      new Map([["Bob", { status: "resolved", userId: "u-bob", displayName: "Bob" }]]),
    );
    const db = makeDbFluentChain([[{ id: 5, title: "My ticket" }]]);
    const instance = new WorkActionsTools(db, confirmation);
    const tool = findTool(instance.tools(), "assignTicket");

    const outcome = await tool.run({ ticketId: 5, assigneeName: "Bob" }, makeCtx());

    expect(outcome.kind).toBe("needs-confirmation");
    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ticket.assign", payload: expect.objectContaining({ assigneeId: "u-bob" }) }),
    );
  });

  it("resolves a ticket assignment for a member whose org never used the HR or directory paths, because the seam drives from members not people", async () => {
    const confirmation = makeConfirmation();
    (resolvePeopleByName as jest.Mock).mockResolvedValue(
      new Map([["Priya", { status: "resolved", userId: "u-priya", displayName: "Priya Sharma" }]]),
    );
    const db = makeDbFluentChain([[{ id: 10, title: "Deploy task" }]]);
    const instance = new WorkActionsTools(db, confirmation);
    const tool = findTool(instance.tools(), "assignTicket");

    const outcome = await tool.run({ ticketId: 10, assigneeName: "Priya" }, makeCtx());

    expect(outcome.kind).toBe("needs-confirmation");
    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ticket.assign",
        payload: expect.objectContaining({ assigneeId: "u-priya", assigneeName: "Priya Sharma" }),
      }),
    );
  });
});

describe("WorkActionsTools — moveTicketToSprint", () => {
  it("returns needs-confirmation and does not execute a write itself", async () => {
    const confirmation = makeConfirmation();
    const db = makeDbFluentChain([
      [{ id: 7, title: "Auth task" }],
      [{ id: 3, name: "Sprint 3" }],
    ]);
    const instance = new WorkActionsTools(db, confirmation);
    const tool = findTool(instance.tools(), "moveTicketToSprint");

    const outcome = await tool.run({ ticketId: 7, sprintName: "Sprint 3" }, makeCtx());

    expect(outcome.kind).toBe("needs-confirmation");
    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ticket.moveToSprint" }),
    );
  });
});

describe("WorkActionsTools — createCalendarEvent", () => {
  it("returns needs-confirmation and does not execute a write itself", async () => {
    const confirmation = makeConfirmation();
    const instance = new WorkActionsTools(makeDbFluentChain([]), confirmation);
    const tool = findTool(instance.tools(), "createCalendarEvent");

    const outcome = await tool.run(
      { title: "Team sync", startDate: "2026-09-20T10:00:00Z", endDate: "2026-09-20T11:00:00Z" },
      makeCtx(),
    );

    expect(outcome.kind).toBe("needs-confirmation");
  });

  it("carries the actor timezone in the proposal payload, not UTC", async () => {
    const confirmation = makeConfirmation();
    const instance = new WorkActionsTools(makeDbFluentChain([]), confirmation);
    const tool = findTool(instance.tools(), "createCalendarEvent");

    await tool.run(
      { title: "Stand-up", startDate: "2026-09-20T09:00:00Z", endDate: "2026-09-20T09:30:00Z" },
      makeCtx({ actor: makeActor({ timezone: "Asia/Kolkata" }) }),
    );

    const call = (confirmation.propose as jest.Mock).mock.calls[0]?.[0] as { payload: Record<string, unknown> };
    expect(call.payload["timezone"]).toBe("Asia/Kolkata");
    expect(call.payload["timezone"]).not.toBe("UTC");
  });

  it("carries the actor timezone even when it differs from UTC", async () => {
    const confirmation = makeConfirmation();
    const instance = new WorkActionsTools(makeDbFluentChain([]), confirmation);
    const tool = findTool(instance.tools(), "createCalendarEvent");

    await tool.run(
      { title: "Interview", startDate: "2026-09-21T14:00:00Z", endDate: "2026-09-21T15:00:00Z" },
      makeCtx({ actor: makeActor({ timezone: "Europe/London" }) }),
    );

    const call = (confirmation.propose as jest.Mock).mock.calls[0]?.[0] as { payload: Record<string, unknown> };
    expect(call.payload["timezone"]).toBe("Europe/London");
  });
});

describe("WorkActionsTools — replyToMailThread", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns needs-confirmation when mailbox is connected", async () => {
    (resolveAnyMailConnection as jest.Mock).mockResolvedValue({ connected: true });
    const confirmation = makeConfirmation();
    const instance = new WorkActionsTools(makeDbFluentChain([]), confirmation);
    const tool = findTool(instance.tools(), "replyToMailThread");

    const outcome = await tool.run({ threadId: "thread-abc", body: "Thanks!" }, makeCtx());

    expect(outcome.kind).toBe("needs-confirmation");
    expect(confirmation.propose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mail.reply" }),
    );
  });

  it("returns needs-connection with reason no-connection when no mailbox is linked", async () => {
    (resolveAnyMailConnection as jest.Mock).mockResolvedValue({
      connected: false,
      toolkit: "gmail",
      reason: "no-connection",
    });
    const instance = makeInstance([]);
    const tool = findTool(instance.tools(), "replyToMailThread");

    const outcome = await tool.run({ threadId: "thread-abc", body: "Hi" }, makeCtx());

    expect(outcome.kind).toBe("needs-connection");
    if (outcome.kind === "needs-connection") {
      expect(outcome.reason).toBe("no-connection");
    }
  });

  it("returns needs-connection with reason needs-reauth when the token has expired", async () => {
    (resolveAnyMailConnection as jest.Mock).mockResolvedValue({
      connected: false,
      toolkit: "gmail",
      reason: "needs-reauth",
    });
    const instance = makeInstance([]);
    const tool = findTool(instance.tools(), "replyToMailThread");

    const outcome = await tool.run({ threadId: "thread-xyz", body: "Follow up" }, makeCtx());

    expect(outcome.kind).toBe("needs-connection");
    if (outcome.kind === "needs-connection") {
      expect(outcome.reason).toBe("needs-reauth");
    }
  });

  it("no-connection and needs-reauth produce distinguishable outcomes", async () => {
    const noConn = { connected: false as const, toolkit: "gmail" as const, reason: "no-connection" as const };
    const reauth = { connected: false as const, toolkit: "gmail" as const, reason: "needs-reauth" as const };
    const tool = findTool(makeInstance([]).tools(), "replyToMailThread");

    (resolveAnyMailConnection as jest.Mock).mockResolvedValue(noConn);
    const outcomeA = await tool.run({ threadId: "t1", body: "a" }, makeCtx());

    (resolveAnyMailConnection as jest.Mock).mockResolvedValue(reauth);
    const outcomeB = await tool.run({ threadId: "t1", body: "a" }, makeCtx());

    expect(outcomeA.kind).toBe("needs-connection");
    expect(outcomeB.kind).toBe("needs-connection");
    if (outcomeA.kind === "needs-connection" && outcomeB.kind === "needs-connection") {
      expect(outcomeA.reason).not.toBe(outcomeB.reason);
      expect(outcomeA.reason).toBe("no-connection");
      expect(outcomeB.reason).toBe("needs-reauth");
    }
  });
});
