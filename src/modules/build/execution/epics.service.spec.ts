import { NotFoundException } from "@nestjs/common";
import { EpicsService } from "./epics.service";
import { BuildTicketCreationService, ProjectsTicketsUpdateService, TicketVersionConflictException } from "../core/tickets";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import type { AccessService } from "../../access/access.service";

const ORG = "org-1";
const PROJECT_ID = 5;
const EPIC_ID = 42;
const VERSION = 3;

const STUB_EPIC_ROW = { id: EPIC_ID, orgId: ORG, version: VERSION, title: "Epic", type: "EPIC" };

function makeU(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG,
    role: "member",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(10, false),
  };
}

function makeDb(firstEpic: Record<string, unknown> | null = null, secondEpic: Record<string, unknown> | null = STUB_EPIC_ROW) {
  const findFirst = jest.fn()
    .mockResolvedValueOnce(firstEpic)
    .mockResolvedValueOnce(secondEpic);
  return {
    query: { tickets: { findFirst } },
    select: jest.fn(),
    update: jest.fn(),
  } as unknown as Db;
}

function makeTicketCreation() {
  return { createInTransaction: jest.fn(), publish: jest.fn() } as unknown as BuildTicketCreationService;
}

function makeTicketChange() {
  return {
    updateTicket: jest.fn().mockResolvedValue({ updated: true, updatedAt: new Date().toISOString(), version: VERSION + 1 }),
  } as unknown as ProjectsTicketsUpdateService;
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("EpicsService.updateEpic — canonical mutation path", () => {
  it("routes the epic ticket update through canonical updateTicket and passes the current version", async () => {
    const db = makeDb({ id: EPIC_ID, version: VERSION });
    const ticketChange = makeTicketChange();
    const u = makeU();
    const svc = new EpicsService(db, makeTicketCreation(), ticketChange, stubService<AccessService>({}));

    await svc.updateEpic(u, PROJECT_ID, EPIC_ID, { version: VERSION, title: "New title", startDate: undefined, dueDate: undefined });

    expect(ticketChange.updateTicket).toHaveBeenCalledTimes(1);
    expect(ticketChange.updateTicket).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG }),
      PROJECT_ID,
      EPIC_ID,
      expect.objectContaining({ title: "New title", version: VERSION }),
    );
  });

  it("does not call db.update(tickets) directly — canonical path owns the write", async () => {
    const db = makeDb({ id: EPIC_ID, version: VERSION });
    const ticketChange = makeTicketChange();
    const svc = new EpicsService(db, makeTicketCreation(), ticketChange, stubService<AccessService>({}));

    await svc.updateEpic(makeU(), PROJECT_ID, EPIC_ID, { version: VERSION, title: "New title", startDate: undefined, dueDate: undefined });

    expect((db as unknown as { update: jest.Mock }).update).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the epic does not exist before calling updateTicket", async () => {
    const db = makeDb(null);
    const ticketChange = makeTicketChange();
    const svc = new EpicsService(db, makeTicketCreation(), ticketChange, stubService<AccessService>({}));

    await expect(
      svc.updateEpic(makeU(), PROJECT_ID, EPIC_ID, { version: VERSION, startDate: undefined, dueDate: undefined }),
    ).rejects.toThrow(NotFoundException);
    expect(ticketChange.updateTicket).not.toHaveBeenCalled();
  });

  it("propagates TicketVersionConflictException from updateTicket to the caller", async () => {
    const db = makeDb({ id: EPIC_ID, version: VERSION });
    const ticketChange = makeTicketChange();
    (ticketChange.updateTicket as jest.Mock).mockRejectedValue(new TicketVersionConflictException(VERSION + 1));
    const svc = new EpicsService(db, makeTicketCreation(), ticketChange, stubService<AccessService>({}));

    await expect(
      svc.updateEpic(makeU(), PROJECT_ID, EPIC_ID, { version: VERSION, startDate: undefined, dueDate: undefined }),
    ).rejects.toThrow(TicketVersionConflictException);
  });

  it("passes health field to updateTicket when provided", async () => {
    const db = makeDb({ id: EPIC_ID, version: VERSION });
    const ticketChange = makeTicketChange();
    const svc = new EpicsService(db, makeTicketCreation(), ticketChange, stubService<AccessService>({}));

    await svc.updateEpic(makeU(), PROJECT_ID, EPIC_ID, { version: VERSION, health: "at_risk", startDate: undefined, dueDate: undefined });

    expect(ticketChange.updateTicket).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      EPIC_ID,
      expect.objectContaining({ health: "at_risk" }),
    );
  });

  it("converts null assigneeId to empty string so canonical path clears the assignee", async () => {
    const db = makeDb({ id: EPIC_ID, version: VERSION });
    const ticketChange = makeTicketChange();
    const svc = new EpicsService(db, makeTicketCreation(), ticketChange, stubService<AccessService>({}));

    await svc.updateEpic(makeU(), PROJECT_ID, EPIC_ID, { version: VERSION, assigneeId: null, startDate: undefined, dueDate: undefined });

    expect(ticketChange.updateTicket).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      EPIC_ID,
      expect.objectContaining({ assigneeId: "" }),
    );
  });
});
