import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AccessService } from "../../../access/access.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ProjectsForbiddenTicketException } from "../../../../common/http/api-exceptions";
import { ProjectsTicketsDetailService } from "./projects-tickets-detail.service";
import { MEMBER_STANDING, standingAccess } from "../../__tests__/project-access-doubles";

const user: CurrentUserContext = {
  orgId: "org-a", userId: "user-a", role: "MEMBER", isOrgOwner: false,
  sessionId: "test", tokenScopes: null, principal: humanSessionPrincipal(7, false),
};

describe("ticket detail permission revocation", () => {
  it.each(["id", "key"])("denies %s lookup before reading even when the caller remains the assignee", async (lookup) => {
    const findFirst = jest.fn().mockResolvedValue({
      id: 11, reporterId: user.userId, assignee: { user: { id: user.userId } }, assignees: [],
    });
    const scopeFor = jest.fn().mockResolvedValue("none");
    const module = await Test.createTestingModule({ providers: [
      ProjectsTicketsDetailService,
      { provide: DRIZZLE, useValue: { query: { tickets: { findFirst } } } },
      { provide: AccessService, useValue: { scopeFor } },
      { provide: AuditService, useValue: { log: jest.fn() } },
    ] }).compile();
    try {
      const service = module.get(ProjectsTicketsDetailService);
      const result = lookup === "id" ? service.getTicket(user, 3, 11) : service.getTicketByKey(user, 3, 11);
      await expect(result).rejects.toBeInstanceOf(ProjectsForbiddenTicketException);
      expect(scopeFor).toHaveBeenCalledTimes(1);
      expect(findFirst).not.toHaveBeenCalled();
    } finally { await module.close(); }
  });

  it.each(["id", "key"])("denies %s lookup when the actor cannot reach the URL project", async (lookup) => {
    const findFirst = jest.fn().mockResolvedValue({
      id: 11,
      projectId: 3,
      reporterId: user.userId,
      epicId: null,
      assignee: null,
      assignees: [],
      watchers: [],
    });
    const accessRows = {
      from: jest.fn(),
      leftJoin: jest.fn(),
      where: jest.fn(),
      limit: jest.fn().mockResolvedValue([
        { projectId: 3, projectState: "ACTIVE", projectDeletedAt: null, reachable: false, inScope: true },
      ]),
    };
    accessRows.from.mockReturnValue(accessRows);
    accessRows.leftJoin.mockReturnValue(accessRows);
    accessRows.where.mockReturnValue(accessRows);
    const module = await Test.createTestingModule({ providers: [
      ProjectsTicketsDetailService,
      {
        provide: DRIZZLE,
        useValue: {
          query: {
            tickets: { findFirst },
          },
          select: jest.fn().mockReturnValue(accessRows),
        },
      },
      {
        provide: AccessService,
        useValue: standingAccess(MEMBER_STANDING),
      },
      { provide: AuditService, useValue: { log: jest.fn() } },
    ] }).compile();
    try {
      const service = module.get(ProjectsTicketsDetailService);
      const result = lookup === "id" ? service.getTicket(user, 3, 11) : service.getTicketByKey(user, 3, 11);
      await expect(result).rejects.toBeInstanceOf(ProjectsForbiddenTicketException);
      expect(findFirst).toHaveBeenCalledTimes(1);
    } finally { await module.close(); }
  });
});
