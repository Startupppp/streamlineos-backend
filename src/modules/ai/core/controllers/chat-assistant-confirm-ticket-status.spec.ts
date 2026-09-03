/**
 * A confirmed `ticket.updateStatus` goes through `ProjectsTicketsService`, not a
 * raw `UPDATE tickets`.
 *
 * THE DEFECT. Eight of `confirmAction`'s nine branches call the owning module's
 * service. The ninth wrote the column itself:
 *
 *     await this.db.update(tickets)
 *       .set({ status: String(payload["status"]) })
 *       .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, u.orgId)));
 *
 * Diffed against `ProjectsTicketsUpdateService.updateTicket`, that predicate and
 * that statement skip, in order: `isNull(tickets.deletedAt)` (a soft-deleted
 * ticket is updated), `checkProjectAccess` (a holder of `build:tickets:update`
 * with no access to the ticket's project succeeds), `validateTicketStatus` (an
 * unknown status reaches the composite FK `fk_tickets_status` as an opaque 500
 * instead of `ProjectsInvalidTicketStatusException`), `enforceWipLimitForStatus`,
 * `assertTransitionAllowed`, the `version` bump and its optimistic check, the
 * `updatedAt` bump (so the NEXT `expectedUpdatedAt` check compares a stale
 * timestamp and lets a conflicting edit through), the
 * `build.ticket.status_changed` outbox row, the activity-log entry, the
 * review-requested/changes-requested notification,
 * `automationRunner.runForTicketEvent`, and the
 * `projects:analytics:<org>:<project>` cache eviction — so the project analytics
 * panel serves the pre-change status until the key expires.
 *
 * The path is reachable from the product: `ProjectsCopilotTools.updateTicketStatus`
 * proposes the action, the user confirms the card, and `POST /chat/confirm`
 * redeems the token.
 *
 * The assertions below are behavioural rather than a source grep, so they stay
 * true if the branch is later moved into a runner service.
 */
jest.mock("@composio/core", () => ({ Composio: jest.fn() }));
jest.mock("../workspace-copilot-tools", () => ({ WorkspaceCopilotTools: jest.fn() }));
jest.mock("../comms-copilot-tools", () => ({ CommsCopilotTools: jest.fn() }));
jest.mock("../../../calendar/calendar.service", () => ({ CalendarService: jest.fn() }));
jest.mock("../../../integrations/core/composio.gateway", () => ({ ComposioGateway: jest.fn() }));
jest.mock("../../../../common/ratelimit/rate-limit.service", () => ({ RateLimitService: jest.fn() }));

import { BadRequestException } from "@nestjs/common";
import { ChatAssistantController } from "./chat-assistant.controller";
import { ProjectsTicketsService } from "../../../build/core/projects-tickets.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

const ACTOR: CurrentUserContext = {
  userId: "user_confirm",
  orgId: "org_confirm",
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "sess_confirm",
  tokenScopes: null,
  principal: humanSessionPrincipal(9, false),
};

function makeController(payload: Record<string, unknown>) {
  const updateTicket = jest.fn().mockResolvedValue({ updated: true, updatedAt: "2026-09-03T00:00:00.000Z" });
  const markExecuted = jest.fn().mockResolvedValue(undefined);

  const confirmation = {
    confirm: jest.fn().mockResolvedValue({
      proposalId: 501,
      action: "ticket.updateStatus",
      payload,
    }),
    markExecuted,
  };

  const moduleRef = {
    get: jest.fn((token: unknown) =>
      token === ProjectsTicketsService ? { updateTicket } : {},
    ),
  };

  const controller = new ChatAssistantController(
    {} as never,
    {} as never,
    {} as never,
    confirmation as never,
    { denyReason: jest.fn().mockResolvedValue(null) } as never,
    moduleRef as never,
  );

  return { controller, updateTicket, markExecuted, moduleRef };
}

describe("POST /chat/confirm — ticket.updateStatus", () => {
  it("delegates to ProjectsTicketsService.updateTicket rather than writing the column", async () => {
    const { controller, updateTicket, moduleRef } = makeController({
      ticketId: 4231,
      status: "IN_REVIEW",
      title: "Fix the thing",
    });

    const outcome = await controller.confirmAction({ token: "1.2.3" }, ACTOR);

    expect(moduleRef.get).toHaveBeenCalledWith(ProjectsTicketsService, { strict: false });
    expect(updateTicket).toHaveBeenCalledTimes(1);
    expect(updateTicket).toHaveBeenCalledWith(ACTOR, 4231, { status: "IN_REVIEW" });
    expect(outcome).toMatchObject({
      ok: true,
      result: { ticketId: 4231, status: "IN_REVIEW" },
    });
  });

  it("passes the actor through, so checkProjectAccess and the scope still apply", async () => {
    const { controller, updateTicket } = makeController({ ticketId: 7, status: "DONE" });

    await controller.confirmAction({ token: "1.2.3" }, ACTOR);

    const [actorArg] = updateTicket.mock.calls[0] as [CurrentUserContext];
    expect(actorArg).toBe(ACTOR);
  });

  it("surfaces a service rejection instead of swallowing it", async () => {
    const { controller, updateTicket, markExecuted } = makeController({ ticketId: 7, status: "NOPE" });
    updateTicket.mockRejectedValue(new BadRequestException("Invalid ticket status"));

    await expect(controller.confirmAction({ token: "1.2.3" }, ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(markExecuted).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-numeric ticketId", { ticketId: "not-a-number", status: "DONE" }],
    ["a zero ticketId", { ticketId: 0, status: "DONE" }],
    ["a blank status", { ticketId: 7, status: "   " }],
    ["a missing status", { ticketId: 7 }],
  ])("rejects %s with 400 and never reaches the service", async (_label, payload) => {
    const { controller, updateTicket, markExecuted } = makeController(payload);

    await expect(controller.confirmAction({ token: "1.2.3" }, ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(updateTicket).not.toHaveBeenCalled();
    expect(markExecuted).not.toHaveBeenCalled();
  });
});
