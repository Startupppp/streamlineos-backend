import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BuildTicketCreationService, TicketVersionConflictException } from "../core/tickets";
import { CyclesService } from "./cycles.service";
import { ModulesService } from "./modules.service";
import { EpicsService } from "./epics.service";

function makeFindFirst(row: Record<string, unknown> | undefined) {
  return jest.fn().mockResolvedValue(row);
}

function makeUpdateMock(returnRows: Record<string, unknown>[]) {
  return jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(returnRows) }),
    }),
  });
}

function makeSelectChain(rows: Record<string, unknown>[]) {
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

async function cyclesService(cycleRow: Record<string, unknown> | undefined, updateReturnRows: Record<string, unknown>[] = []) {
  const update = makeUpdateMock(updateReturnRows);
  const db = {
    update,
    select: makeSelectChain(cycleRow ? [cycleRow] : []),
    query: {
      projects: { findFirst: makeFindFirst({ id: 1, orgId: "org-1" }) },
      cycles: { findFirst: makeFindFirst(cycleRow) },
    },
  };
  const module = await Test.createTestingModule({
    providers: [CyclesService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return { service: module.get(CyclesService), module, update };
}

async function modulesService(moduleRow: Record<string, unknown> | undefined, updateReturnRows: Record<string, unknown>[] = []) {
  const update = makeUpdateMock(updateReturnRows);
  const db = {
    update,
    select: makeSelectChain(moduleRow ? [moduleRow] : []),
    query: {
      modules: { findFirst: makeFindFirst(moduleRow) },
    },
  };
  const module = await Test.createTestingModule({
    providers: [ModulesService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return { service: module.get(ModulesService), module, update };
}

async function epicsService(ticketRow: Record<string, unknown> | undefined, updateReturnRows: Record<string, unknown>[] = []) {
  const update = makeUpdateMock(updateReturnRows);
  const db = {
    update,
    select: makeSelectChain(ticketRow ? [ticketRow] : []),
    query: {
      tickets: { findFirst: makeFindFirst(ticketRow) },
    },
  };
  const module = await Test.createTestingModule({
    providers: [
      EpicsService,
      { provide: DRIZZLE, useValue: db },
      { provide: BuildTicketCreationService, useValue: { createInTransaction: jest.fn(), publish: jest.fn() } },
    ],
  }).compile();
  return { service: module.get(EpicsService), module, update };
}

it("cycle stale token returns 409 with currentVersion in details (ticket-13)", async () => {
  const { service, module } = await cyclesService({ version: 5 });
  const error = await service.updateCycle("org-1", 1, 10, { version: 3, name: "Sprint Q1" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TicketVersionConflictException);
  expect((error as TicketVersionConflictException).getResponse()).toMatchObject({ details: { currentVersion: 5 } });
  await module.close();
});

it("cycle matching token does not throw TicketVersionConflictException and runs the update query (BE-141 positive pair)", async () => {
  const cycleRow = { id: 10, orgId: "org-1", projectId: 1, name: "Sprint Q1", description: null, status: "draft", startDate: "2026-01-01", endDate: "2026-01-14", version: 6, createdBy: "u-1", createdAt: new Date(), updatedAt: new Date(), deletedAt: null };
  const { service, module, update } = await cyclesService({ version: 5 }, [cycleRow]);
  const error = await service.updateCycle("org-1", 1, 10, { version: 5, name: "Sprint Q1" }).catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(TicketVersionConflictException);
  expect(update).toHaveBeenCalled();
  await module.close();
});

it("module stale token returns 409 with currentVersion in details (ticket-13)", async () => {
  const { service, module } = await modulesService({ version: 3 });
  const error = await service.updateModule("org-1", 1, 20, { version: 1, name: "Auth" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TicketVersionConflictException);
  expect((error as TicketVersionConflictException).getResponse()).toMatchObject({ details: { currentVersion: 3 } });
  await module.close();
});

it("module matching token does not throw TicketVersionConflictException and runs the update query (BE-141 positive pair)", async () => {
  const moduleRow = { id: 20, orgId: "org-1", projectId: 1, name: "Auth", description: null, status: "backlog", leadId: null, startDate: null, endDate: null, version: 4, createdBy: "u-1", createdAt: new Date(), updatedAt: new Date() };
  const { service, module, update } = await modulesService({ version: 3 }, [moduleRow]);
  const error = await service.updateModule("org-1", 1, 20, { version: 3, name: "Auth" }).catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(TicketVersionConflictException);
  expect(update).toHaveBeenCalled();
  await module.close();
});

it("epic stale token returns 409 with currentVersion in details (ticket-13)", async () => {
  const { service, module } = await epicsService({ version: 7 });
  const error = await service.updateEpic("org-1", 1, 30, { version: 2, title: "Big epic" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TicketVersionConflictException);
  expect((error as TicketVersionConflictException).getResponse()).toMatchObject({ details: { currentVersion: 7 } });
  await module.close();
});

it("epic matching token does not throw TicketVersionConflictException and runs the update query (BE-141 positive pair)", async () => {
  const epicRow = { id: 30, orgId: "org-1", projectId: 1, title: "Big epic", type: "EPIC", version: 8, status: "TODO", priority: "MEDIUM", ticketNumber: 1, cycleId: null, epicId: null, assigneeMembershipId: null, points: null, storyPoints: null, startDate: null, dueDate: null, estimate: null, completionPercentage: 0, rank: "a", timeSpent: "0", deletedAt: null, createdAt: new Date(), updatedAt: new Date(), reporterId: null, description: null, moduleId: null };
  const { service, module, update } = await epicsService({ version: 7 }, [epicRow]);
  const error = await service.updateEpic("org-1", 1, 30, { version: 7, title: "Big epic" }).catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(TicketVersionConflictException);
  expect(update).toHaveBeenCalled();
  await module.close();
});
