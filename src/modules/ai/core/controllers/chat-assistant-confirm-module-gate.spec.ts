jest.mock("@composio/core", () => ({ Composio: jest.fn() }));
jest.mock("../tools/workspace-copilot-tools", () => ({ WorkspaceCopilotTools: jest.fn() }));
jest.mock("../tools/comms-copilot-tools", () => ({ CommsCopilotTools: jest.fn() }));
jest.mock("../../../calendar/calendar.service", () => ({ CalendarService: jest.fn() }));
jest.mock("../../../integrations/core/composio.gateway", () => ({ ComposioGateway: jest.fn() }));
jest.mock("../../../../common/ratelimit/rate-limit.service", () => ({ RateLimitService: jest.fn() }));

import { ForbiddenException } from "@nestjs/common";
import { ChatAssistantController } from "./chat-assistant.controller";
import { ModuleDisabledException } from "../../../../common/http/api-exceptions";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { AuthContext } from "../../../../common/auth/auth-context";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

const ACTOR: CurrentUserContext = {
  userId: "user-module-gate",
  orgId: "org-module-gate",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-module-gate",
  tokenScopes: null,
  principal: humanSessionPrincipal(42, false),
};

const TICKET_PAYLOAD = {
  projectId: 3,
  title: "Ship the thing",
  type: "TASK",
  priority: "MEDIUM",
};

function makeHarness(available: boolean, reason = "org-disabled", denyReason: string | null = null) {
  const markExecuted = jest.fn().mockResolvedValue(undefined);
  const auditDeniedExecution = jest.fn().mockResolvedValue(undefined);
  const createTicket = jest.fn().mockResolvedValue({ id: 9, title: TICKET_PAYLOAD.title });
  const confirmation = {
    confirm: jest.fn().mockResolvedValue({
      proposalId: 1,
      action: "ticket.create",
      payload: TICKET_PAYLOAD,
    }),
    markExecuted,
    auditDeniedExecution,
  };
  const moduleAvailable = jest.fn().mockResolvedValue(
    available ? { available: true } : { available: false, reason },
  );
  const authCtx = { actor: ACTOR, moduleAvailable } as unknown as AuthContext;
  const controller = new ChatAssistantController(
    {} as never,
    {} as never,
    {} as never,
    { getFlags: jest.fn().mockResolvedValue({ aiChat: true }) } as never,
    confirmation as never,
    { denyReason: jest.fn().mockResolvedValue(denyReason) } as never,
    { get: jest.fn().mockReturnValue({ createTicket }) } as never,
  );
  return {
    controller,
    authCtx,
    moduleAvailable,
    markExecuted,
    createTicket,
    auditDeniedExecution,
  };
}

describe("confirming a card whose module was disabled after it was minted", () => {
  it("refuses the confirm, because POST /build/tickets would 402 while this path executed the same write anyway", async () => {
    const { controller, authCtx } = makeHarness(false);

    await expect(
      controller.confirmAction({ token: "t.t.t" }, ACTOR, authCtx),
    ).rejects.toBeInstanceOf(ModuleDisabledException);
  });

  it("performs no write when the module is gone", async () => {
    const { controller, authCtx, markExecuted, createTicket } = makeHarness(false);

    await expect(
      controller.confirmAction({ token: "t.t.t" }, ACTOR, authCtx),
    ).rejects.toBeInstanceOf(ModuleDisabledException);
    expect(createTicket).not.toHaveBeenCalled();
    expect(markExecuted).not.toHaveBeenCalled();
  });

  it("asks about the module that administers the action's own permission rather than the chat module hosting the route", async () => {
    const { controller, authCtx, moduleAvailable } = makeHarness(false);

    await expect(
      controller.confirmAction({ token: "t.t.t" }, ACTOR, authCtx),
    ).rejects.toBeInstanceOf(ModuleDisabledException);
    expect(moduleAvailable).toHaveBeenCalledWith("build");
  });

  it("leaves an audit trace when the module gate refuses, because a redeemed card that executed nothing is otherwise invisible", async () => {
    const { controller, authCtx, auditDeniedExecution } = makeHarness(false);

    await expect(
      controller.confirmAction({ token: "t.t.t" }, ACTOR, authCtx),
    ).rejects.toBeInstanceOf(ModuleDisabledException);
    expect(auditDeniedExecution).toHaveBeenCalled();
  });

  it("leaves an audit trace when the permission re-check refuses a confirmed card", async () => {
    const { controller, authCtx, auditDeniedExecution, createTicket } = makeHarness(
      true,
      "org-disabled",
      "You do not have permission to create tickets.",
    );

    await expect(
      controller.confirmAction({ token: "t.t.t" }, ACTOR, authCtx),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(createTicket).not.toHaveBeenCalled();
    expect(auditDeniedExecution).toHaveBeenCalled();
  });

  it("writes no denial audit row when the confirm succeeds, so the trace means what it says", async () => {
    const { controller, authCtx, auditDeniedExecution } = makeHarness(true);

    await controller.confirmAction({ token: "t.t.t" }, ACTOR, authCtx);

    expect(auditDeniedExecution).not.toHaveBeenCalled();
  });

  it("still executes when the module is enabled, so the gate cannot pass by refusing everything", async () => {
    const { controller, authCtx, markExecuted, createTicket } = makeHarness(true);

    const outcome = await controller.confirmAction({ token: "t.t.t" }, ACTOR, authCtx);

    expect(createTicket).toHaveBeenCalled();
    expect(markExecuted).toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });
});
