jest.mock("../project-crud/project-access", () => ({
  ...jest.requireActual("../project-crud/project-access"),
  authorizeProjectTicketRead: jest.fn(),
}));

import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { CacheService } from "../../../../common/cache/cache.service";
import { AccessService } from "../../../access/access.service";
import { ScopedRead } from "../../../access/scoped-read";
import { NotificationsService } from "../../../notifications/notifications.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { authorizeProjectTicketRead } from "../project-crud/project-access";
import { BuildTicketCreationService } from "./build-ticket-creation.service";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";

const ORG = "org-own";
const PROJECT_ID = 42;

const actor: CurrentUserContext = {
  orgId: ORG,
  userId: "user-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session",
  tokenScopes: null,
  principal: humanSessionPrincipal(7, false),
};

function exportRow(number: number) {
  return {
    number,
    title: `Ticket ${number}`,
    type: "TASK",
    status: "TODO",
    priority: "MEDIUM",
    points: null,
    dueDate: null,
    assigneeName: null,
    assigneeFirstName: null,
    assigneeLastName: null,
    assigneeEmail: null,
  };
}

function exportDb(rows: unknown[]) {
  const chain = {
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn(async () => rows),
  };
  return { select: jest.fn(() => chain), chain };
}

async function transferService(db: unknown) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsTicketsTransferService,
      { provide: DRIZZLE, useValue: db },
      { provide: ProjectsTicketsReadService, useValue: {} },
      { provide: AccessService, useValue: {} },
      { provide: NotificationsService, useValue: {} },
      { provide: NotificationDispatchService, useValue: {} },
      { provide: CacheService, useValue: {} },
      { provide: BuildTicketCreationService, useValue: {} },
    ],
  }).compile();
  return moduleRef.get(ProjectsTicketsTransferService);
}

describe("ProjectsTicketsTransferService.exportTickets — a ticketIds list fails whole", () => {
  beforeEach(() => {
    jest.mocked(authorizeProjectTicketRead).mockReset();
  });

  it("refuses the whole export with 404 when one requested id is foreign or unreachable, exporting nothing", async () => {
    jest.mocked(authorizeProjectTicketRead).mockResolvedValue(ScopedRead.of(ORG, actor.userId, "all"));
    const db = exportDb([exportRow(1)]);
    const svc = await transferService(db);

    await expect(svc.exportTickets(actor, PROJECT_ID, [11, 999])).rejects.toBeInstanceOf(NotFoundException);
    expect(db.chain.limit).toHaveBeenCalledTimes(1);
  });

  it("exports every requested ticket when all ids are the caller's own", async () => {
    jest.mocked(authorizeProjectTicketRead).mockResolvedValue(ScopedRead.of(ORG, actor.userId, "all"));
    const svc = await transferService(exportDb([exportRow(1), exportRow(2)]));

    const result = await svc.exportTickets(actor, PROJECT_ID, [11, 12]);

    expect(result.rows.map((row) => row.number)).toEqual([1, 2]);
    expect(result.truncated).toBe(false);
  });

  it("counts a repeated id once, so a duplicate in the list is not mistaken for a foreign id", async () => {
    jest.mocked(authorizeProjectTicketRead).mockResolvedValue(ScopedRead.of(ORG, actor.userId, "all"));
    const svc = await transferService(exportDb([exportRow(1)]));

    const result = await svc.exportTickets(actor, PROJECT_ID, [11, 11]);

    expect(result.rows).toHaveLength(1);
  });

  it("refuses with 404 when the caller has no ticket read scope but names ids, and returns empty when it names none", async () => {
    jest.mocked(authorizeProjectTicketRead).mockResolvedValue(ScopedRead.of(ORG, actor.userId, "none"));
    const db = exportDb([]);
    const svc = await transferService(db);

    await expect(svc.exportTickets(actor, PROJECT_ID, [11])).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.exportTickets(actor, PROJECT_ID)).resolves.toEqual({ rows: [], truncated: false });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("exports the whole project when no ids are named, without a count check", async () => {
    jest.mocked(authorizeProjectTicketRead).mockResolvedValue(ScopedRead.of(ORG, actor.userId, "all"));
    const svc = await transferService(exportDb([exportRow(1), exportRow(2), exportRow(3)]));

    const result = await svc.exportTickets(actor, PROJECT_ID, []);

    expect(result.rows).toHaveLength(3);
  });
});
