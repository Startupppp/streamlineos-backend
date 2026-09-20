jest.mock("@composio/core", () => ({ Composio: jest.fn() }));
jest.mock("../tools/workspace-copilot-tools", () => ({ WorkspaceCopilotTools: jest.fn() }));
jest.mock("../tools/comms-copilot-tools", () => ({ CommsCopilotTools: jest.fn() }));
jest.mock("../../../calendar/calendar.service", () => ({ CalendarService: jest.fn() }));
jest.mock("../../../integrations/core/composio.gateway", () => ({ ComposioGateway: jest.fn() }));
jest.mock("../../../../common/ratelimit/rate-limit.service", () => ({ RateLimitService: jest.fn() }));

import { ForbiddenException } from "@nestjs/common";
import { ChatAssistantController } from "./chat-assistant.controller";
import { CONFIRMABLE_ACTIONS, CONFIRM_ACTION_PERMISSION } from "../confirm-actions";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

const ACTOR: CurrentUserContext = {
  userId: "user-actions-test",
  orgId: "org-actions-test",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-actions-test",
  tokenScopes: null,
  principal: humanSessionPrincipal(42, false),
};

const SELF_PROVIDER_ACTIONS = [
  "self.applyLeave",
  "self.submitExpense",
  "self.logTimesheet",
  "self.submitReferral",
] as const;

const WORK_PROVIDER_ACTIONS = [
  "crm.createLead",
  "crm.logActivity",
  "ticket.assign",
  "ticket.moveToSprint",
  "calendar.createEvent",
  "mail.reply",
] as const;

const ALL_PROVIDER_ACTIONS: ReadonlyArray<string> = [
  ...SELF_PROVIDER_ACTIONS,
  ...WORK_PROVIDER_ACTIONS,
];

function makeController(action: string, payload: Record<string, unknown>, denyReason: string | null = null) {
  const markExecuted = jest.fn().mockResolvedValue(undefined);
  const confirmation = {
    confirm: jest.fn().mockResolvedValue({ proposalId: 1, action, payload }),
    markExecuted,
  };
  const moduleRef = { get: jest.fn().mockReturnValue({}) };
  const controller = new ChatAssistantController(
    {} as never,
    {} as never,
    {} as never,
    { getFlags: jest.fn().mockResolvedValue({ aiChat: true }) } as never,
    confirmation as never,
    { denyReason: jest.fn().mockResolvedValue(denyReason) } as never,
    moduleRef as never,
  );
  return { controller, confirmation, moduleRef, markExecuted };
}

describe("CONFIRMABLE_ACTIONS — coverage of provider action names", () => {
  it("contains every action name that SelfActionsTools proposals emit", () => {
    for (const action of SELF_PROVIDER_ACTIONS) {
      expect(CONFIRMABLE_ACTIONS).toContain(action);
    }
  });

  it("contains every action name that WorkActionsTools proposals emit", () => {
    for (const action of WORK_PROVIDER_ACTIONS) {
      expect(CONFIRMABLE_ACTIONS).toContain(action);
    }
  });

  it("the ten new actions are all represented", () => {
    expect(ALL_PROVIDER_ACTIONS).toHaveLength(10);
    for (const action of ALL_PROVIDER_ACTIONS) {
      expect(CONFIRMABLE_ACTIONS).toContain(action);
    }
  });
});

describe("CONFIRM_ACTION_PERMISSION — every confirmable action has a permission key", () => {
  it.each(CONFIRMABLE_ACTIONS)("action %s has a CONFIRM_ACTION_PERMISSION entry", (action) => {
    expect(CONFIRM_ACTION_PERMISSION[action]).toBeDefined();
    expect(typeof CONFIRM_ACTION_PERMISSION[action]).toBe("string");
    expect(CONFIRM_ACTION_PERMISSION[action].length).toBeGreaterThan(0);
  });

  it("no action is missing a permission — the record is complete", () => {
    const keys = Object.keys(CONFIRM_ACTION_PERMISSION);
    for (const action of CONFIRMABLE_ACTIONS) {
      expect(keys).toContain(action);
    }
  });
});

describe("POST /chat/confirm — permission re-check on confirmed action", () => {
  it.each(["self.applyLeave", "crm.createLead", "ticket.assign", "calendar.createEvent", "mail.reply"])(
    "throws ForbiddenException when denyReason is set for action %s",
    async (action) => {
      const { controller } = makeController(action, {}, "Permission denied for this resource");
      await expect(controller.confirmAction({ token: "t.t.t" }, ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it("markExecuted is never called when permission is denied", async () => {
    const { controller, markExecuted } = makeController("self.submitExpense", {}, "denied");
    await expect(controller.confirmAction({ token: "t.t.t" }, ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
    expect(markExecuted).not.toHaveBeenCalled();
  });
});

describe("POST /chat/confirm — actor identity never sourced from payload", () => {
  it("the actor userId is taken from CurrentUserContext, not payload, for self.applyLeave", async () => {
    const capturedArgs: unknown[] = [];
    const leaveSvc = {
      create: jest.fn().mockImplementation((...args: unknown[]) => {
        capturedArgs.push(...args);
        return Promise.resolve({ success: true });
      }),
    };
    const moduleRef = {
      get: jest.fn().mockImplementation(() => leaveSvc),
    };
    const confirmation = {
      confirm: jest.fn().mockResolvedValue({
        proposalId: 2,
        action: "self.applyLeave",
        payload: {
          userId: "attacker-supplied-id",
          leaveTypeId: 1,
          startDate: "2026-10-01",
          endDate: "2026-10-03",
          reason: "A long enough reason for testing",
        },
      }),
      markExecuted: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new ChatAssistantController(
      {} as never,
      {} as never,
      {} as never,
      { getFlags: jest.fn().mockResolvedValue({ aiChat: true }) } as never,
      confirmation as never,
      { denyReason: jest.fn().mockResolvedValue(null) } as never,
      moduleRef as never,
    );

    await controller.confirmAction({ token: "t.t.t" }, ACTOR);

    expect(leaveSvc.create).toHaveBeenCalledTimes(1);
    const [actorArg] = leaveSvc.create.mock.calls[0] as [CurrentUserContext];
    expect(actorArg.userId).toBe(ACTOR.userId);
    expect(actorArg.userId).not.toBe("attacker-supplied-id");
  });

  it("the actor userId is taken from CurrentUserContext, not payload, for self.submitExpense", async () => {
    const expenseSvc = {
      create: jest.fn().mockResolvedValue({ id: 99 }),
    };
    const moduleRef = { get: jest.fn().mockReturnValue(expenseSvc) };
    const confirmation = {
      confirm: jest.fn().mockResolvedValue({
        proposalId: 3,
        action: "self.submitExpense",
        payload: {
          userId: "should-not-be-used",
          category: "Travel",
          amount: 50,
          date: "2026-10-01",
        },
      }),
      markExecuted: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new ChatAssistantController(
      {} as never,
      {} as never,
      {} as never,
      { getFlags: jest.fn().mockResolvedValue({ aiChat: true }) } as never,
      confirmation as never,
      { denyReason: jest.fn().mockResolvedValue(null) } as never,
      moduleRef as never,
    );

    await controller.confirmAction({ token: "t.t.t" }, ACTOR);

    expect(expenseSvc.create).toHaveBeenCalledTimes(1);
    const [orgIdArg, userIdArg] = expenseSvc.create.mock.calls[0] as [string, string];
    expect(orgIdArg).toBe(ACTOR.orgId);
    expect(userIdArg).toBe(ACTOR.userId);
    expect(userIdArg).not.toBe("should-not-be-used");
  });

  it("the actor userId is taken from CurrentUserContext, not payload, for self.logTimesheet", async () => {
    const capturedActors: unknown[] = [];
    const entrySvc = {
      createEntry: jest.fn().mockImplementation((...args: unknown[]) => {
        capturedActors.push(args[0]);
        return Promise.resolve({ id: 77 });
      }),
    };
    const moduleRef = { get: jest.fn().mockReturnValue(entrySvc) };
    const confirmation = {
      confirm: jest.fn().mockResolvedValue({
        proposalId: 4,
        action: "self.logTimesheet",
        payload: {
          userId: "attacker",
          hours: 8,
          date: "2026-10-01",
        },
      }),
      markExecuted: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new ChatAssistantController(
      {} as never,
      {} as never,
      {} as never,
      { getFlags: jest.fn().mockResolvedValue({ aiChat: true }) } as never,
      confirmation as never,
      { denyReason: jest.fn().mockResolvedValue(null) } as never,
      moduleRef as never,
    );

    await controller.confirmAction({ token: "t.t.t" }, ACTOR);

    const actorArg = capturedActors[0] as CurrentUserContext;
    expect(actorArg.userId).toBe(ACTOR.userId);
    expect(actorArg.userId).not.toBe("attacker");
  });
});
