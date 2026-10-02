import { NotFoundException } from "@nestjs/common";
import { EpicsService } from "./epics.service";
import { BuildTicketCreationService, ProjectsTicketsUpdateService, ProjectsTicketsDeleteService, TicketVersionConflictException } from "../core/tickets";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import type { AccessService } from "../../access/access.service";
import { authorizeTicketMutation } from "../core";
import { ForbiddenException } from "@nestjs/common";

jest.mock("../core/project-crud/project-access", () => ({
  ...jest.requireActual<object>("../core/project-crud/project-access"),
  authorizeTicketMutation: jest.fn(),
  readMutationTickets: jest.fn(),
}));

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

function makeTicketDelete() {
  return { deleteTicket: jest.fn().mockResolvedValue({ deleted: true }) } as unknown as ProjectsTicketsDeleteService;
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("EpicsService.updateEpic — canonical mutation path", () => {
  it("routes the epic ticket update through canonical updateTicket and passes the current version", async () => {
    const db = makeDb({ id: EPIC_ID, version: VERSION });
    const ticketChange = makeTicketChange();
    const u = makeU();
    const svc = new EpicsService(db, makeTicketCreation(), ticketChange, makeTicketDelete(), stubService<AccessService>({}));

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
    const svc = new EpicsService(db, makeTicketCreation(), ticketChange, makeTicketDelete(), stubService<AccessService>({}));

    await svc.updateEpic(makeU(), PROJECT_ID, EPIC_ID, { version: VERSION, title: "New title", startDate: undefined, dueDate: undefined });

    expect((db as unknown as { update: jest.Mock }).update).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the epic does not exist before calling updateTicket", async () => {
    const db = makeDb(null);
    const ticketChange = makeTicketChange();
    const svc = new EpicsService(db, makeTicketCreation(), ticketChange, makeTicketDelete(), stubService<AccessService>({}));

    await expect(
      svc.updateEpic(makeU(), PROJECT_ID, EPIC_ID, { version: VERSION, startDate: undefined, dueDate: undefined }),
    ).rejects.toThrow(NotFoundException);
    expect(ticketChange.updateTicket).not.toHaveBeenCalled();
  });

  it("propagates TicketVersionConflictException from updateTicket to the caller", async () => {
    const db = makeDb({ id: EPIC_ID, version: VERSION });
    const ticketChange = makeTicketChange();
    (ticketChange.updateTicket as jest.Mock).mockRejectedValue(new TicketVersionConflictException(VERSION + 1));
    const svc = new EpicsService(db, makeTicketCreation(), ticketChange, makeTicketDelete(), stubService<AccessService>({}));

    await expect(
      svc.updateEpic(makeU(), PROJECT_ID, EPIC_ID, { version: VERSION, startDate: undefined, dueDate: undefined }),
    ).rejects.toThrow(TicketVersionConflictException);
  });

  it("passes health field to updateTicket when provided", async () => {
    const db = makeDb({ id: EPIC_ID, version: VERSION });
    const ticketChange = makeTicketChange();
    const svc = new EpicsService(db, makeTicketCreation(), ticketChange, makeTicketDelete(), stubService<AccessService>({}));

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
    const svc = new EpicsService(db, makeTicketCreation(), ticketChange, makeTicketDelete(), stubService<AccessService>({}));

    await svc.updateEpic(makeU(), PROJECT_ID, EPIC_ID, { version: VERSION, assigneeId: null, startDate: undefined, dueDate: undefined });

    expect(ticketChange.updateTicket).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      EPIC_ID,
      expect.objectContaining({ assigneeId: "" }),
    );
  });
});

describe("EpicsService.deleteEpic — delegates to ProjectsTicketsDeleteService", () => {
  it("delegates to ticketDelete.deleteTicket and returns success", async () => {
    const db = makeDb({ id: EPIC_ID, version: VERSION });
    const ticketDelete = makeTicketDelete();
    const u = makeU();
    const svc = new EpicsService(db, makeTicketCreation(), makeTicketChange(), ticketDelete, stubService<AccessService>({}));

    const result = await svc.deleteEpic(u, PROJECT_ID, EPIC_ID);

    expect((ticketDelete.deleteTicket as jest.Mock)).toHaveBeenCalledWith(u, PROJECT_ID, EPIC_ID, false);
    expect(result).toEqual({ success: true });
  });

  it("throws NotFoundException and does not call deleteTicket when the epic does not exist or is not an EPIC", async () => {
    const db = makeDb(null);
    const ticketDelete = makeTicketDelete();
    const svc = new EpicsService(db, makeTicketCreation(), makeTicketChange(), ticketDelete, stubService<AccessService>({}));

    await expect(svc.deleteEpic(makeU(), PROJECT_ID, EPIC_ID)).rejects.toThrow(NotFoundException);
    expect((ticketDelete.deleteTicket as jest.Mock)).not.toHaveBeenCalled();
  });

  it("refuses before the canonical delete when the caller cannot mutate the project's tickets", async () => {
    jest.mocked(authorizeTicketMutation).mockRejectedValue(new ForbiddenException("Not authorized to update this project"));
    const db = makeDb({ id: EPIC_ID, version: VERSION });
    const ticketDelete = makeTicketDelete();
    const svc = new EpicsService(db, makeTicketCreation(), makeTicketChange(), ticketDelete, stubService<AccessService>({}));

    await expect(svc.deleteEpic(makeU(), PROJECT_ID, EPIC_ID)).rejects.toThrow(ForbiddenException);
    expect((ticketDelete.deleteTicket as jest.Mock)).not.toHaveBeenCalled();
  });
});
