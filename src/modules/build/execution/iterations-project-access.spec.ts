import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { projectAccessRow } from "../__tests__/project-access-doubles";
import { BuildTicketCreationService, ProjectsTicketsDeleteService, ProjectsTicketsUpdateService } from "../core/tickets";
import { CyclesService } from "./cycles.service";
import { EpicsService } from "./epics.service";
import { ModulesService } from "./modules.service";
import {
  createCycleSchema,
  createEpicSchema,
  createModuleSchema,
  updateCycleSchema,
  updateEpicSchema,
  updateModuleSchema,
} from "./dto/iterations.schemas";

const ORG_ID = "org-1";
const PROJECT_ID = 7;
const CALLER_MEMBERSHIP = 21;

const caller: CurrentUserContext = {
  userId: "user-21",
  orgId: ORG_ID,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(CALLER_MEMBERSHIP, false),
};

type ProjectStanding = "member" | "non-member" | "foreign";

function projectRowsFor(standing: ProjectStanding) {
  if (standing === "foreign") return [];
  return [projectAccessRow({ manages: standing === "member" })];
}

function makeDb(standing: ProjectStanding, row: Record<string, unknown> = { id: 5, version: 1 }) {
  const chain: Record<string, jest.Mock> = {};
  for (const key of ["from", "innerJoin", "where", "orderBy", "groupBy"]) chain[key] = jest.fn(() => chain);
  chain.limit = jest.fn().mockResolvedValue([]);
  chain.for = jest.fn().mockResolvedValue([{ id: row.id, allowed: true }]);
  const projectChain: Record<string, jest.Mock> = {};
  for (const key of ["from", "where"]) projectChain[key] = jest.fn(() => projectChain);
  projectChain.limit = jest.fn().mockResolvedValue(projectRowsFor(standing));
  const returning = jest.fn().mockResolvedValue([row]);
  const write = { set: jest.fn(), values: jest.fn(), where: jest.fn() };
  write.set.mockReturnValue(write);
  write.values.mockReturnValue({ returning });
  write.where.mockReturnValue({ returning });
  const tx = { update: jest.fn(() => write), delete: jest.fn(() => write) };
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(standing === "foreign" ? undefined : { id: PROJECT_ID }) },
      tickets: { findFirst: jest.fn().mockResolvedValue(row), findMany: jest.fn().mockResolvedValue([]) },
      cycles: { findFirst: jest.fn().mockResolvedValue(row) },
      modules: { findFirst: jest.fn().mockResolvedValue(row) },
    },
    select: jest.fn((fields?: Record<string, unknown>) => (fields !== undefined && "memberRole" in fields ? projectChain : chain)),
    insert: jest.fn(() => write),
    update: jest.fn(() => write),
    transaction: jest.fn(async (work: (handle: typeof tx) => Promise<unknown>) => work(tx)),
  };
}

async function build(standing: ProjectStanding) {
  const db = makeDb(standing);
  const ticketCreation = { create: jest.fn().mockResolvedValue({ tickets: [{ id: 5 }], command: {} }) };
  const ticketChange = { updateTicket: jest.fn().mockResolvedValue(undefined) };
  const ticketDelete = { deleteTicket: jest.fn().mockResolvedValue(undefined) };
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    scopeFor: jest.fn(async (_user: CurrentUserContext, key: string) =>
      key === "build:manage" ? "none" : key === "build:view" ? "own" : "all",
    ),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      CyclesService,
      EpicsService,
      ModulesService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: access },
      { provide: BuildTicketCreationService, useValue: ticketCreation },
      { provide: ProjectsTicketsUpdateService, useValue: ticketChange },
      { provide: ProjectsTicketsDeleteService, useValue: ticketDelete },
    ],
  }).compile();
  return {
    db,
    ticketCreation,
    ticketChange,
    ticketDelete,
    cycles: moduleRef.get(CyclesService),
    epics: moduleRef.get(EpicsService),
    modules: moduleRef.get(ModulesService),
  };
}

type Built = Awaited<ReturnType<typeof build>>;

const MUTATIONS: Array<[string, (built: Built) => Promise<unknown>]> = [
  ["POST /build/:projectId/epics", ({ epics }) => epics.createEpic(caller, PROJECT_ID, createEpicSchema.parse({ title: "Epic" }))],
  ["DELETE /build/:projectId/epics/:epicId", ({ epics }) => epics.deleteEpic(caller, PROJECT_ID, 5)],
  [
    "POST /build/:projectId/cycles",
    ({ cycles }) =>
      cycles.createCycle(
        caller,
        PROJECT_ID,
        createCycleSchema.parse({ name: "Cycle", startDate: "2026-10-01", endDate: "2026-10-14" }),
      ),
  ],
  [
    "PATCH /build/:projectId/cycles/:cycleId",
    ({ cycles }) => cycles.updateCycle(caller, PROJECT_ID, 5, updateCycleSchema.parse({ name: "Renamed", version: 1 })),
  ],
  ["DELETE /build/:projectId/cycles/:cycleId", ({ cycles }) => cycles.deleteCycle(caller, PROJECT_ID, 5)],
  [
    "POST /build/:projectId/modules",
    ({ modules }) => modules.createModule(caller, PROJECT_ID, createModuleSchema.parse({ name: "Payments" })),
  ],
  [
    "PATCH /build/:projectId/modules/:moduleId",
    ({ modules }) => modules.updateModule(caller, PROJECT_ID, 5, updateModuleSchema.parse({ name: "Renamed", version: 1 })),
  ],
  ["DELETE /build/:projectId/modules/:moduleId", ({ modules }) => modules.deleteModule(caller, PROJECT_ID, 5)],
];

const READS: Array<[string, (built: Built) => Promise<unknown>]> = [
  ["GET /build/:projectId/epics", ({ epics }) => epics.listEpics(caller, PROJECT_ID)],
  ["GET /build/:projectId/cycles", ({ cycles }) => cycles.listCycles(caller, PROJECT_ID, {})],
  ["GET /build/:projectId/modules", ({ modules }) => modules.listModules(caller, PROJECT_ID)],
];

function wrote(built: Built): boolean {
  return (
    built.db.insert.mock.calls.length > 0 ||
    built.db.update.mock.calls.length > 0 ||
    built.db.transaction.mock.calls.length > 0 ||
    built.ticketCreation.create.mock.calls.length > 0 ||
    built.ticketDelete.deleteTicket.mock.calls.length > 0
  );
}

describe("epics, cycles and modules require access to the project they write into", () => {
  it.each(MUTATIONS)("%s answers 403 to a same-org caller who is not on the project, before any write", async (_route, call) => {
    const built = await build("non-member");
    await expect(call(built)).rejects.toThrow(ForbiddenException);
    expect(wrote(built)).toBe(false);
  });

  it.each(MUTATIONS)("%s answers 404 for a project outside the caller's tenant, before any write", async (_route, call) => {
    const built = await build("foreign");
    await expect(call(built)).rejects.toThrow(NotFoundException);
    expect(wrote(built)).toBe(false);
  });

  it.each(MUTATIONS)("%s succeeds for the project's manager and reaches the write", async (_route, call) => {
    const built = await build("member");
    await expect(call(built)).resolves.toBeDefined();
    expect(wrote(built)).toBe(true);
  });
});

describe("epic, cycle and module lists conceal a project the caller cannot see", () => {
  it.each(READS)("%s answers 404 to a same-org caller who is not on the project", async (_route, call) => {
    const built = await build("non-member");
    await expect(call(built)).rejects.toThrow(NotFoundException);
  });

  it.each(READS)("%s answers 404 for a project outside the caller's tenant", async (_route, call) => {
    const built = await build("foreign");
    await expect(call(built)).rejects.toThrow(NotFoundException);
  });

  it.each(READS)("%s lists for the project's manager", async (_route, call) => {
    const built = await build("member");
    await expect(call(built)).resolves.toBeDefined();
  });
});

describe("PATCH /build/:projectId/epics/:epicId is authorized by the canonical ticket update", () => {
  const input = updateEpicSchema.parse({ title: "Renamed", version: 1 });

  it("answers 404 for an epic outside the caller's tenant without reaching the ticket update", async () => {
    const built = await build("foreign");
    built.db.query.tickets.findFirst.mockResolvedValue(undefined);
    await expect(built.epics.updateEpic(caller, PROJECT_ID, 5, input)).rejects.toThrow(NotFoundException);
    expect(built.ticketChange.updateTicket).not.toHaveBeenCalled();
  });

  it("propagates the canonical update's 403 for a caller who cannot mutate the project's tickets", async () => {
    const built = await build("non-member");
    built.ticketChange.updateTicket.mockRejectedValue(new ForbiddenException("Not authorized to update this project"));
    await expect(built.epics.updateEpic(caller, PROJECT_ID, 5, input)).rejects.toThrow(ForbiddenException);
  });

  it("hands the caller to the canonical update and returns the re-read epic", async () => {
    const built = await build("member");
    await expect(built.epics.updateEpic(caller, PROJECT_ID, 5, input)).resolves.toMatchObject({ id: 5 });
    expect(built.ticketChange.updateTicket).toHaveBeenCalledWith(caller, PROJECT_ID, 5, { version: 1, title: "Renamed" });
  });
});
