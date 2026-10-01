import { ForbiddenException, NotFoundException } from "@nestjs/common";
import * as projectAccess from "../core/project-crud/project-access";
import { TimesheetsService } from "./timesheets.service";
import type { AccessService } from "../../access/access.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { EntriesPeriodService } from "../../timesheets/core/entries-period.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { LogTimeInput } from "./dto/timesheets.schemas";

const ORG = "org-1";
const MEMBERSHIP_ID = 7;
const PROJECT_A = 11;
const TICKET_A = 901;

function makeU(): CurrentUserContext {
  return {
    userId: "user-7",
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
  };
}

const LOG: LogTimeInput = { date: "2026-01-15", hours: 2 };

function makeService(ticketRow: unknown) {
  const findTicket = jest.fn().mockResolvedValue(ticketRow);
  const findProject = jest.fn().mockResolvedValue({ id: PROJECT_A, orgId: ORG, deletedAt: null });

  const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      insert: () => ({ values: () => ({ returning: async () => [{ id: 1, orgId: ORG, projectId: PROJECT_A, ticketId: TICKET_A, hours: "2", timesheetPeriodId: null }] }) }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    }),
  );

  const db = {
    query: { tickets: { findFirst: findTicket }, projects: { findFirst: findProject } },
    select: jest.fn().mockReturnValue({ from: () => ({ where: async () => [{ total: 0 }] }) }),
    update: jest.fn().mockReturnValue({ set: () => ({ where: async () => {} }) }),
    transaction,
  };

  const access = {
    holds: jest.fn().mockResolvedValue(true),
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])),
  } as unknown as AccessService;

  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService;
  const periodService = {
    loadSettings: jest.fn().mockResolvedValue({ workWeekStart: 1 }),
    getOrCreatePeriod: jest.fn().mockResolvedValue(77),
  } as unknown as EntriesPeriodService;

  return { svc: new TimesheetsService(db as never, cache, access, periodService), findProject };
}

describe("TimesheetsService.logTicketTime — delegates project write access to assertProjectWriteAccess, so an archived project refuses time logs", () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it("calls assertProjectWriteAccess with the URL projectId and propagates ForbiddenException (403, not pass)", async () => {
    const { svc } = makeService({ projectId: PROJECT_A });
    jest.spyOn(projectAccess, "assertProjectWriteAccess").mockRejectedValue(new ForbiddenException());

    await expect(svc.logTicketTime(makeU(), PROJECT_A, TICKET_A, LOG)).rejects.toBeInstanceOf(ForbiddenException);
    expect(projectAccess.assertProjectWriteAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), makeU(), PROJECT_A);
  });

  it("succeeds when assertProjectWriteAccess passes (control)", async () => {
    const { svc } = makeService({ projectId: PROJECT_A });
    jest.spyOn(projectAccess, "assertProjectWriteAccess").mockResolvedValue(undefined);

    await expect(svc.logTicketTime(makeU(), PROJECT_A, TICKET_A, LOG)).resolves.toBeDefined();
    expect(projectAccess.assertProjectWriteAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), makeU(), PROJECT_A);
  });

  it("raises NotFoundException before reaching assertProjectWriteAccess when the ticket is absent", async () => {
    const { svc, findProject } = makeService(undefined);

    await expect(svc.logTicketTime(makeU(), PROJECT_A, TICKET_A, LOG)).rejects.toBeInstanceOf(NotFoundException);
    expect(findProject).not.toHaveBeenCalled();
  });
});
