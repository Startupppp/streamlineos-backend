import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { AccessService } from "../../access/access.service";
import { MANAGER_STANDING, projectAccessRow, standingAccess } from "../core/project-crud/__tests__/project-access-doubles";
import { TicketExportService } from "./ticket-export.service";

const ORG = "org-own";
const PROJECT_ID = 42;

const actor: CurrentUserContext = {
  orgId: ORG,
  userId: "user-1",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

function exportRow(ticketNumber: number) {
  return {
    ticketNumber,
    title: `Ticket ${ticketNumber}`,
    description: null,
    type: "TASK",
    status: "TODO",
    priority: "MEDIUM",
    startDate: null,
    dueDate: null,
    points: null,
    storyPoints: null,
    estimate: null,
    completionPercentage: 0,
    clientVisible: false,
    link: null,
  };
}

function exportDb(ticketRows: unknown[]) {
  const projectChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn(async () => [projectAccessRow()]),
  };
  const ticketChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn(async (_cap: number) => ticketRows),
  };
  const select = jest.fn((fields?: Record<string, unknown>) =>
    fields !== undefined && "manages" in fields ? projectChain : ticketChain,
  );
  return { select, ticketChain };
}

async function exportService(db: unknown) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      TicketExportService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: standingAccess(MANAGER_STANDING) },
    ],
  }).compile();
  return moduleRef.get(TicketExportService);
}

describe("TicketExportService.exportTickets — a ticketIds list fails whole", () => {
  it("refuses the whole export with 404 when one requested id is foreign or unreachable, producing no content", async () => {
    const svc = await exportService(exportDb([exportRow(1)]));

    await expect(
      svc.exportTickets(actor, PROJECT_ID, { format: "json", ticketIds: [11, 999] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("exports every requested ticket when all ids are the caller's own", async () => {
    const svc = await exportService(exportDb([exportRow(1), exportRow(2)]));

    const result = await svc.exportTickets(actor, PROJECT_ID, { format: "json", ticketIds: [11, 12] });

    expect(result.rowCount).toBe(2);
    expect(JSON.parse(result.content)).toHaveLength(2);
  });

  it("counts a repeated id once, so a duplicate in the list is not mistaken for a foreign id", async () => {
    const svc = await exportService(exportDb([exportRow(1)]));

    const result = await svc.exportTickets(actor, PROJECT_ID, { format: "csv", ticketIds: [11, 11] });

    expect(result.rowCount).toBe(1);
  });

  it("reads every requested id even under a smaller limit, so the limit cannot pass for a foreign id, then trims to the limit", async () => {
    const db = exportDb([exportRow(1), exportRow(2)]);
    const svc = await exportService(db);

    const result = await svc.exportTickets(actor, PROJECT_ID, { format: "json", limit: 1, ticketIds: [11, 12] });

    expect(db.ticketChain.limit).toHaveBeenCalledWith(2);
    expect(result.rowCount).toBe(1);
  });

  it("exports the project up to the limit when no ids are named, without a count check", async () => {
    const db = exportDb([exportRow(1), exportRow(2), exportRow(3)]);
    const svc = await exportService(db);

    const result = await svc.exportTickets(actor, PROJECT_ID, { format: "json", limit: 3 });

    expect(db.ticketChain.limit).toHaveBeenCalledWith(3);
    expect(result.rowCount).toBe(3);
  });
});
