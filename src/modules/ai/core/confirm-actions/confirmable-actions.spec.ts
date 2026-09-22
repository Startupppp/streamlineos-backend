import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ModuleRef } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import {
  CONFIRMABLE_ACTIONS,
  CONFIRMABLE_ACTION_DEFINITIONS,
  CONFIRM_ACTION_PERMISSION,
  findConfirmableAction,
} from ".";
import {
  assertResolvableActionServices,
  assertUniqueActions,
  defineConfirmableAction,
  parseProposedPayload,
} from "./confirmable-action.types";
import { PERMISSIONS } from "../../../rbac/permissions";
import { ProjectsTicketsService } from "../../../build/core/projects-tickets.service";
import { ProjectsTicketCommentsService } from "../../../build/core/projects-ticket-comments.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";

jest.mock("../../../directory/person-seam", () => ({
  ...jest.requireActual("../../../directory/person-seam"),
  resolvePeopleByName: jest.fn(),
}));

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn((_db: unknown, fn: () => unknown) => fn()),
}));

import { resolvePeopleByName } from "../../../directory/person-seam";

const resolveNames = jest.mocked(resolvePeopleByName);

const TOOLS_ROOT = join(__dirname, "..");
const PROPOSE_SITE = /(?:\.propose\(\{|needsConfirmation\(\{)/g;
const ACTION_FIELD =
  /action:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*))/;
const MAX_SITE_WINDOW = 4_000;

interface ScannedSite {
  file: string;
  source: string;
  action: string | undefined;
  expression: string | undefined;
}

const SELF_REDEEMED_ACTIONS: readonly string[] = ["meetings.send-follow-up"];

function resolveLocalConstant(source: string, identifier: string): string | undefined {
  const declaration = new RegExp(
    `(?:const|let|var)\\s+${identifier.replace(/\$/g, "\\$")}\\s*(?::[^=]+)?=\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`$]*)\`)`,
  ).exec(source);
  if (!declaration) return undefined;
  return declaration[1] ?? declaration[2] ?? declaration[3];
}

function scanProposeSites(): ScannedSite[] {
  const sites: ScannedSite[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "confirm-actions" && entry.name !== "__tests__") walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) continue;
      const source = readFileSync(full, "utf8");
      const starts = [...source.matchAll(PROPOSE_SITE)].map((match) => match.index);
      starts.forEach((start, position) => {
        const nextStart = starts[position + 1] ?? source.length;
        const end = Math.min(nextStart, start + MAX_SITE_WINDOW);
        const field = ACTION_FIELD.exec(source.slice(start, end));
        if (!field) {
          sites.push({ file: full, source, action: undefined, expression: undefined });
          return;
        }
        const literal = field[1] ?? field[2] ?? field[3];
        if (literal !== undefined) {
          sites.push({ file: full, source, action: literal, expression: field[0] });
          return;
        }
        const identifier = field[4] ?? "";
        const resolved = identifier.includes(".")
          ? undefined
          : resolveLocalConstant(source, identifier);
        sites.push({ file: full, source, action: resolved, expression: field[0] });
      });
    }
  };
  walk(TOOLS_ROOT);
  return sites;
}

const PROPOSE_FIXTURES: Readonly<Record<string, Record<string, unknown>>> = {
  "ticket.create": {
    projectId: 7,
    title: "Fix the confirmation card",
    description: "Body",
    type: "TASK",
    priority: "HIGH",
    assigneeId: "user-1",
  },
  "ticket.updateStatus": {
    ticketId: 41,
    status: "IN_REVIEW",
    title: "Fix the confirmation card",
    reason: "Ready for QA",
  },
  "ticket.addComment": { ticketId: 41, comment: "Looks good" },
  "ticket.assign": { ticketId: 41, assigneeId: "user-1", assigneeName: "Jordan Lee" },
  "ticket.moveToCycle": { ticketId: 41, cycleId: 3, cycleName: "Cycle 3" },
  "ticket.moveToSprint": { ticketId: 41, sprintId: 3, sprintName: "Sprint 3" },
  "email.send": { toEmail: "someone@example.com", subject: "Hello", body: "Body" },
  "chat.postChannel": { channelId: 5, channelName: "general", message: "Hello" },
  "chat.sendDirect": { targetUserId: "user-1", message: "Hello" },
  "mail.send": {
    accountId: 2,
    toEmail: "someone@example.com",
    subject: "Hello",
    body: "Body",
  },
  "mail.reply": {
    threadId: "thread-1",
    body: "Body",
    accountEmail: "me@example.com",
  },
  "mail.archive": {
    accountId: 3,
    messageId: "msg-1",
    threadId: "thread-1",
  },
  "crm.createLead": {
    name: "Acme",
    email: "buyer@example.com",
    phone: "+1 555 0100",
    company: "Acme Inc",
    notes: "Inbound",
  },
  "crm.logActivity": {
    leadIdentifier: 9,
    leadName: "Acme",
    type: "call",
    notes: "Discovery call",
    dueDate: "2026-10-01T10:00:00.000Z",
  },
  "crm.updateLeadStatus": {
    leadId: 9,
    leadName: "Acme",
    status: "qualified",
    priority: "high",
  },
  "self.applyLeave": {
    leaveTypeId: 1,
    startDate: "2026-10-01",
    endDate: "2026-10-02",
    reason: "Family",
  },
  "self.submitExpense": {
    category: "Travel",
    amount: 120.5,
    description: "Taxi",
    date: "2026-10-01",
  },
  "self.logTimesheet": {
    date: "2026-10-01",
    hours: 7.5,
    projectId: 7,
    description: "Build work",
  },
  "self.submitReferral": {
    candidateName: "Jordan Lee",
    candidateEmail: "jordan@example.com",
    jobPostingId: 4,
    notes: "Strong fit",
  },
  "self.applyToJobOpening": {
    jobId: 5,
    coverLetter: "Excited to apply for this role",
    notes: "Available from next month",
  },
  "calendar.createReminder": {
    title: "Follow up",
    startDate: "2026-10-01T10:00:00.000Z",
    endDate: "2026-10-01T10:15:00.000Z",
    timezone: "America/New_York",
    description: "Ping the customer",
    fromTicketId: 41,
  },
  "calendar.createEvent": {
    title: "Design review",
    startDate: "2026-10-01T10:00:00.000Z",
    endDate: "2026-10-01T11:00:00.000Z",
    timezone: "America/New_York",
    attendeeNames: ["Jordan Lee"],
    location: "Room 2",
    description: "Review the new cards",
  },
  "calendar.scheduleMeeting": {
    title: "Team sync",
    startDate: "2026-10-01T10:00:00.000Z",
    endDate: "2026-10-01T11:00:00.000Z",
    timezone: "America/New_York",
    attendeeIds: ["user-1"],
    location: "Room 2",
    description: "Weekly",
  },
  "hr.grantRecognition": { toUserId: "user-1", message: "Great work", category: "KUDOS" },
  "hr.grantBonus": {
    employeeId: "user-1",
    type: "SPOT",
    amount: 500,
    reason: "Shipped the release",
    month: "2026-10",
    taxable: true,
  },
};

describe("one definition owns an action's key, permission, payload and executor", () => {
  it("every action a tool proposes has an executor, so a proposal cannot be un-redeemable", () => {
    const missing = scanProposeSites()
      .map((site) => site.action)
      .filter((action): action is string => action !== undefined)
      .filter((action) => !SELF_REDEEMED_ACTIONS.includes(action))
      .filter((action) => findConfirmableAction(action) === undefined);

    expect(missing).toEqual([]);
  });

  it("an action exempted as self-redeemed really confirms its own token, so the exemption cannot hide a missing executor", () => {
    const sites = scanProposeSites();

    for (const action of SELF_REDEEMED_ACTIONS) {
      expect(findConfirmableAction(action)).toBeUndefined();
      const owners = sites.filter((site) => site.action === action);
      expect(owners.length).toBeGreaterThan(0);
      expect(owners.some((site) => site.source.includes("confirmation.confirm("))).toBe(true);
    }
  });

  it("reads the action through a hoisted constant or template literal too, because a 600-char literal-only window let one slip past", () => {
    const unreadable = scanProposeSites()
      .filter((site) => site.action === undefined)
      .map((site) => `${site.file}: ${site.expression ?? "no action field found"}`);

    expect(unreadable).toEqual([]);
  });

  it("every definition declares a payload schema, so no branch can coerce raw model output", () => {
    for (const definition of CONFIRMABLE_ACTION_DEFINITIONS) {
      expect(definition.payload).toBeDefined();
      expect(typeof definition.payload.safeParse).toBe("function");
    }
  });

  it("every declared permission exists verbatim in the backend catalog", () => {
    const catalog = new Set(PERMISSIONS.map((permission) => permission.name));
    const ghosts = CONFIRMABLE_ACTION_DEFINITIONS.map((d) => d.permission).filter(
      (key) => !catalog.has(key),
    );

    expect(ghosts).toEqual([]);
  });

  it("derives the action list and the permission map from the same definitions", () => {
    expect(CONFIRMABLE_ACTIONS).toHaveLength(CONFIRMABLE_ACTION_DEFINITIONS.length);
    expect(Object.keys(CONFIRM_ACTION_PERMISSION).sort()).toEqual([...CONFIRMABLE_ACTIONS].sort());
  });

  it("refuses two definitions sharing an action, rather than letting one shadow the other", () => {
    const one = defineConfirmableAction({
      action: "test.duplicate",
      permission: "ai:chat:use",
      payload: z.object({}),
      resolve: () => null,
      execute: async () => ({ result: {}, summary: "" }),
    });

    expect(() => assertUniqueActions([one, { ...one }])).toThrow(
      "Duplicate confirmable action keys: test.duplicate",
    );
  });

  it("rejects a payload the model filled with the wrong shape instead of coercing it", () => {
    const create = findConfirmableAction("ticket.create");

    expect(create?.payload.safeParse({ title: "no project id" }).success).toBe(false);
  });

  it("rejects an outbound email whose recipient is not an address", () => {
    const send = findConfirmableAction("email.send");

    expect(
      send?.payload.safeParse({ toEmail: "undefined", subject: "s", body: "b" }).success,
    ).toBe(false);
  });
});

describe("the payload schema is one contract for the card and the executor", () => {
  it("has a representative propose payload for every registered action", () => {
    expect(Object.keys(PROPOSE_FIXTURES).sort()).toEqual([...CONFIRMABLE_ACTIONS].sort());
  });

  it.each(CONFIRMABLE_ACTIONS)(
    "%s round-trips its propose payload to the execute input, so the card cannot show a field the executor never receives",
    (action) => {
      const definition = findConfirmableAction(action);
      const fixture = PROPOSE_FIXTURES[action] ?? {};

      const parsed: unknown = definition?.propose(fixture);

      expect(Object.keys(fixture).filter((key) => !Object.keys(parsed ?? {}).includes(key))).toEqual(
        [],
      );
    },
  );

  it("keeps the three fields the executors used to throw away after the card had already shown them", () => {
    const event = findConfirmableAction("calendar.createEvent")?.propose(
      PROPOSE_FIXTURES["calendar.createEvent"],
    );
    const reminder = findConfirmableAction("calendar.createReminder")?.propose(
      PROPOSE_FIXTURES["calendar.createReminder"],
    );
    const status = findConfirmableAction("ticket.updateStatus")?.propose(
      PROPOSE_FIXTURES["ticket.updateStatus"],
    );

    expect(event).toMatchObject({ attendeeNames: ["Jordan Lee"], location: "Room 2" });
    expect(reminder).toMatchObject({ timezone: "America/New_York", fromTicketId: 41 });
    expect(status).toMatchObject({ reason: "Ready for QA" });
  });

  it("fails the proposal rather than silently dropping a field no executor reads", () => {
    const comment = findConfirmableAction("ticket.addComment");

    expect(() =>
      comment?.propose({ ticketId: 41, comment: "Looks good", notifyEveryone: true }),
    ).toThrow('would drop payload field(s) the card shows: notifyEveryone');
  });

  it("passes an action no definition owns through untouched, because propose is now the shared seam and the self-redeemed actions have no schema here", () => {
    const payload = { eventId: 7, followUpSubject: "Recap" };

    for (const action of SELF_REDEEMED_ACTIONS)
      expect(parseProposedPayload(action, payload)).toBe(payload);
  });

  it("returns the parsed payload a tool should hand to propose", () => {
    expect(parseProposedPayload("ticket.addComment", { ticketId: "41", comment: "Hi" })).toEqual({
      ticketId: 41,
      comment: "Hi",
    });
  });
});

describe("every executor's service is resolvable before a confirmation token can be burned", () => {
  let moduleRef: ModuleRef;

  beforeAll(async () => {
    const testingModule = await Test.createTestingModule({ providers: [] }).compile();
    moduleRef = testingModule.get(ModuleRef);
  });

  it("throws at boot, not after the proposal is already marked CONFIRMED, when a provider is missing", () => {
    expect(() =>
      assertResolvableActionServices(moduleRef, CONFIRMABLE_ACTION_DEFINITIONS),
    ).toThrow("Confirmable actions cannot resolve their services");
  });

  it("names every action that cannot resolve, not just the first one", () => {
    let message = "";
    try {
      assertResolvableActionServices(moduleRef, CONFIRMABLE_ACTION_DEFINITIONS);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    for (const action of CONFIRMABLE_ACTIONS) expect(message).toContain(action);
  });

  it("passes when every definition resolves what its executor needs", () => {
    const resolvable = defineConfirmableAction({
      action: "test.resolvable",
      permission: "ai:chat:use",
      payload: z.object({}),
      resolve: () => ({ ready: true }),
      execute: async () => ({ result: {}, summary: "" }),
    });

    expect(() => assertResolvableActionServices(moduleRef, [resolvable])).not.toThrow();
  });
});

describe("ticket.updateStatus executor persists reason as a comment", () => {
  const mockActor: CurrentUserContext = {
    userId: "user-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
  };

  function makeModuleRef(
    tickets: Partial<ProjectsTicketsService>,
    comments: Partial<ProjectsTicketCommentsService>,
  ): ModuleRef {
    return {
      get: jest.fn().mockImplementation((token: unknown) =>
        token === ProjectsTicketsService ? tickets : comments,
      ),
    } as unknown as ModuleRef;
  }

  it("calls addComment with the reason when reason is non-empty, so the reason is persisted and not only in the card summary", async () => {
    const mockUpdateTicket = jest.fn().mockResolvedValue({});
    const mockAddComment = jest.fn().mockResolvedValue({ id: 99 });
    const moduleRef = makeModuleRef(
      { updateTicket: mockUpdateTicket },
      { addComment: mockAddComment },
    );
    const definition = findConfirmableAction("ticket.updateStatus");

    await definition?.execute(
      { ticketId: 41, status: "IN_REVIEW", title: "Fix it", reason: "Ready for QA" },
      { actor: mockActor, db: {} as Db, moduleRef, proposalId: 1 },
    );

    expect(mockAddComment).toHaveBeenCalledWith(mockActor, null, 41, { content: "Ready for QA" });
  });

  it("does not call addComment when reason is absent, so no empty comment is created", async () => {
    const mockUpdateTicket = jest.fn().mockResolvedValue({});
    const mockAddComment = jest.fn();
    const moduleRef = makeModuleRef(
      { updateTicket: mockUpdateTicket },
      { addComment: mockAddComment },
    );
    const definition = findConfirmableAction("ticket.updateStatus");

    await definition?.execute(
      { ticketId: 41, status: "IN_REVIEW", title: "Fix it", reason: undefined },
      { actor: mockActor, db: {} as Db, moduleRef, proposalId: 1 },
    );

    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("does not call addComment when reason is all whitespace, so no empty comment is created", async () => {
    const mockUpdateTicket = jest.fn().mockResolvedValue({});
    const mockAddComment = jest.fn();
    const moduleRef = makeModuleRef(
      { updateTicket: mockUpdateTicket },
      { addComment: mockAddComment },
    );
    const definition = findConfirmableAction("ticket.updateStatus");

    await definition?.execute(
      { ticketId: 41, status: "IN_REVIEW", title: "Fix it", reason: "   " },
      { actor: mockActor, db: {} as Db, moduleRef, proposalId: 1 },
    );

    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("summary does not include the reason text, because reason is now a persisted comment not an in-band annotation", async () => {
    const mockUpdateTicket = jest.fn().mockResolvedValue({});
    const mockAddComment = jest.fn().mockResolvedValue({ id: 99 });
    const moduleRef = makeModuleRef(
      { updateTicket: mockUpdateTicket },
      { addComment: mockAddComment },
    );
    const definition = findConfirmableAction("ticket.updateStatus");

    const outcome = await definition?.execute(
      { ticketId: 41, status: "DONE", title: "Ship it", reason: "All tests passed" },
      { actor: mockActor, db: {} as Db, moduleRef, proposalId: 1 },
    );

    expect(outcome?.summary).not.toContain("All tests passed");
    expect(outcome?.summary).toContain("DONE");
  });
});

describe("calendar.createEvent executor resolves attendee names before inviting", () => {
  const mockActor: CurrentUserContext = {
    userId: "user-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
  };

  const basePayload = {
    title: "Design review",
    startDate: "2026-10-01T10:00:00.000Z",
    endDate: "2026-10-01T11:00:00.000Z",
    timezone: "America/New_York",
    location: "Room 2",
    description: "Review the new cards",
  };

  const mockCalendar = {
    createEvent: jest.fn().mockResolvedValue({ event: { id: "evt-1" } }),
  };
  const mockModuleRef = {
    get: jest.fn().mockReturnValue(mockCalendar),
  } as unknown as ModuleRef;

  beforeEach(() => {
    jest.clearAllMocks();
    resolveNames.mockResolvedValue(new Map());
    mockCalendar.createEvent.mockResolvedValue({ event: { id: "evt-1" } });
  });

  it("creates no event at all when a name matches nobody, rather than inviting the rest and reporting success", async () => {
    resolveNames.mockResolvedValue(new Map([["Jordan Lee", { status: "unresolved" }]]));
    const definition = findConfirmableAction("calendar.createEvent");

    await expect(
      definition?.execute(
        { ...basePayload, attendeeNames: ["Jordan Lee"] },
        { actor: mockActor, db: {} as Db, moduleRef: mockModuleRef, proposalId: 1 },
      ),
    ).rejects.toThrow(/"Jordan Lee" matches nobody in this organization/);
    expect(mockCalendar.createEvent).not.toHaveBeenCalled();
  });

  it("names every unidentifiable attendee in one error, so the caller is not made to retry once per bad name", async () => {
    resolveNames.mockResolvedValue(
      new Map([
        ["Jordan Lee", { status: "unresolved" }],
        [
          "Sam Patel",
          {
            status: "ambiguous",
            candidates: [
              { label: "Sam Patel", hint: "sam.a@example.com" },
              { label: "Sam Patel", hint: "sam.b@example.com" },
            ],
          },
        ],
      ]),
    );
    const definition = findConfirmableAction("calendar.createEvent");

    const failure = definition?.execute(
      { ...basePayload, attendeeNames: ["Jordan Lee", "Sam Patel"] },
      { actor: mockActor, db: {} as Db, moduleRef: mockModuleRef, proposalId: 1 },
    );

    await expect(failure).rejects.toThrow(/"Jordan Lee" matches nobody/);
    await expect(failure).rejects.toThrow(/"Sam Patel" matches multiple people: Sam Patel \(sam.a@example.com\), Sam Patel \(sam.b@example.com\)/);
  });

  it("resolves every attendee name in one call, because a lookup per name is an N+1 against organization_people", async () => {
    resolveNames.mockResolvedValue(
      new Map([
        ["Jordan Lee", { status: "resolved", userId: "user-42" }],
        ["Sam Patel", { status: "resolved", userId: "user-43" }],
      ]),
    );
    const definition = findConfirmableAction("calendar.createEvent");

    await definition?.execute(
      { ...basePayload, attendeeNames: ["Jordan Lee", "Sam Patel"] },
      { actor: mockActor, db: {} as Db, moduleRef: mockModuleRef, proposalId: 1 },
    );

    expect(resolveNames).toHaveBeenCalledTimes(1);
    expect(mockCalendar.createEvent).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({ attendeeIds: ["user-42", "user-43"] }),
    );
  });

  it("creates the event without attendees when attendeeNames is absent", async () => {
    const definition = findConfirmableAction("calendar.createEvent");

    await definition?.execute(
      { ...basePayload, attendeeNames: undefined },
      { actor: mockActor, db: {} as Db, moduleRef: mockModuleRef, proposalId: 1 },
    );

    expect(resolveNames).toHaveBeenCalledWith({}, "org-1", []);
    expect(mockCalendar.createEvent).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({ attendeeIds: [] }),
    );
  });
});
