import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { ChangeRequestAffectedItemsService } from "./change-request-affected-items.service";
import { ChangeRequestsService } from "./change-requests.service";

const PROJECT_ID = 10;
const TICKET_ID = 55;
const CALLER_MEMBERSHIP = 21;

const caller: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(CALLER_MEMBERSHIP, false),
};

const TICKET_SUMMARY = {
  id: TICKET_ID,
  projectId: PROJECT_ID,
  title: "Fix the widget",
  ticketNumber: 3,
  status: "TODO",
  priority: "MEDIUM",
  type: "BUG",
};

type TicketStanding = "readable" | "outside-scope" | "foreign";

async function build(standing: TicketStanding) {
  const select = jest.fn((projection: Record<string, unknown>) => {
    const rows =
      standing === "foreign"
        ? []
        : "allowed" in projection
          ? [{ id: TICKET_ID, allowed: standing === "readable" }]
          : "title" in projection
            ? [TICKET_SUMMARY]
            : [];
    const chain = { from: jest.fn(), innerJoin: jest.fn(), where: jest.fn(), limit: jest.fn().mockResolvedValue(rows) };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    return chain;
  });
  const returning = jest.fn().mockResolvedValue([
    { id: 1, orgId: "org-1", changeRequestId: 1, ticketId: TICKET_ID, createdAt: new Date(), createdBy: caller.userId },
  ]);
  const insert = jest.fn(() => ({ values: jest.fn(() => ({ returning })) }));
  const db = {
    query: { projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: CALLER_MEMBERSHIP }) } },
    select,
    insert,
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ChangeRequestAffectedItemsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: ChangeRequestsService, useValue: { getChangeRequest: jest.fn().mockResolvedValue({ id: 1 }) } },
      {
        provide: AccessService,
        useValue: {
          resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
          scopeFor: jest.fn().mockResolvedValue(standing === "outside-scope" ? "own" : "all"),
        },
      },
    ],
  }).compile();
  return { service: moduleRef.get(ChangeRequestAffectedItemsService), insert };
}

describe("POST /build/:projectId/change-requests/:changeRequestId/affected-tickets requires read access to the linked ticket", () => {
  it("answers 403 when the ticket is outside the caller's ticket scope, without linking it", async () => {
    const { service, insert } = await build("outside-scope");
    await expect(service.linkTicket(caller, PROJECT_ID, 1, { ticketId: TICKET_ID })).rejects.toThrow(ForbiddenException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("answers 404 for a ticket outside the caller's tenant, without linking it", async () => {
    const { service, insert } = await build("foreign");
    await expect(service.linkTicket(caller, PROJECT_ID, 1, { ticketId: TICKET_ID })).rejects.toThrow(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("links a ticket the caller can read", async () => {
    const { service, insert } = await build("readable");
    await expect(service.linkTicket(caller, PROJECT_ID, 1, { ticketId: TICKET_ID })).resolves.toMatchObject({
      ticketId: TICKET_ID,
      ticket: { title: TICKET_SUMMARY.title },
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
