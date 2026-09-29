jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

jest.mock("./tickets/ticket-status.util", () => ({
  resolveValidTicketStatuses: jest.fn(),
}));

jest.mock("./project-crud/project-access", () => ({
  ...jest.requireActual("./project-crud/project-access"),
  resolveProjectAccess: jest.fn(),
}));

import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { ProjectsTicketsTransferService } from "./tickets/projects-tickets-transfer.service";
import { ProjectsTicketsQueryService } from "./tickets/projects-tickets-query.service";
import { ProjectsWebhooksDispatchService } from "./webhooks/projects-webhooks-dispatch.service";
import { BuildAutomationRunnerService } from "./automation/build-automation-runner.service";
import type { ProjectsTicketsReadService } from "./tickets/projects-tickets-read.service";
import type { NotificationsService } from "../../notifications/notifications.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { ProjectsActivityService } from "./activity/projects-activity.service";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { ProjectsInvalidTicketStatusException } from "../../../common/http/api-exceptions";
import { resolveValidTicketStatuses } from "./tickets/ticket-status.util";
import { resolveProjectAccess } from "./project-crud/project-access";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

const mockResolveValidTicketStatuses = resolveValidTicketStatuses as jest.MockedFunction<
  typeof resolveValidTicketStatuses
>;
const mockResolveProjectAccess = resolveProjectAccess as jest.MockedFunction<
  typeof resolveProjectAccess
>;

beforeEach(() => {
  jest.resetAllMocks();
  mockResolveValidTicketStatuses.mockResolvedValue(new Set(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]));
});

describe("ProjectsTicketsTransferService — cross-tenant isolation", () => {
  function makeTransferSvc(
    read: Partial<ProjectsTicketsReadService>,
    db: Db,
    scopeFor?: jest.Mock,
    holds?: jest.Mock,
  ): ProjectsTicketsTransferService {
    const access = {
      scopeFor: scopeFor ?? jest.fn().mockResolvedValue("all"),
      holds: holds ?? jest.fn().mockResolvedValue(true),
    } as unknown as AccessService;
    return new ProjectsTicketsTransferService(
      db,
      read as unknown as ProjectsTicketsReadService,
      access,
      {} as unknown as NotificationsService,
      {} as unknown as NotificationDispatchService,
      { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService,
    );
  }

  it("rejects import assignment without build:tickets:assign", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: null });
    const holds = jest.fn().mockResolvedValue(false);
    const svc = makeTransferSvc({} as Partial<ProjectsTicketsReadService>, {} as Db, undefined, holds);
    await expect(
      svc.importTickets(
        { orgId: OWNER_ORG, userId: "u-owner" } as Parameters<typeof svc.importTickets>[0],
        42,
        { rows: [{ title: "Assigned import", assigneeEmail: "member@example.com" }] },
      ),
    ).rejects.toThrow("Not authorized to assign tickets");
    expect(holds).toHaveBeenCalledWith(expect.objectContaining({ orgId: OWNER_ORG }), "build:tickets:assign");
  });

  describe("exportTickets", () => {
    it("throws NotFoundException when project is inaccessible to the caller (DENY)", async () => {
      mockResolveProjectAccess.mockResolvedValue({ hasAccess: false, role: null });
      const db = {} as unknown as Db;
      const svc = makeTransferSvc({} as Partial<ProjectsTicketsReadService>, db);
      await expect(
        svc.exportTickets({ orgId: ATTACKER_ORG, userId: "u-attacker" } as Parameters<typeof svc.exportTickets>[0], 42),
      ).rejects.toThrow(NotFoundException);
    });

    it("passes the caller orgId to resolveProjectAccess (predicate check — DENY)", async () => {
      mockResolveProjectAccess.mockResolvedValue({ hasAccess: false, role: null });
      const db = {} as unknown as Db;
      const svc = makeTransferSvc({} as Partial<ProjectsTicketsReadService>, db);
      await expect(
        svc.exportTickets({ orgId: ATTACKER_ORG, userId: "u-attacker" } as Parameters<typeof svc.exportTickets>[0], 42),
      ).rejects.toThrow(NotFoundException);
      expect(mockResolveProjectAccess).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ orgId: ATTACKER_ORG, userId: "u-attacker" }),
        42,
      );
    });

    it("returns ticket rows scoped to the owning org (CONTROL)", async () => {
      mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: "OWNER" });
      const read = {};
      const ticketRow = {
        number: 1,
        title: "Fix bug",
        type: "BUG",
        status: "TODO",
        priority: "MEDIUM",
        points: null,
        dueDate: null,
        assigneeName: null,
        assigneeFirstName: null,
        assigneeLastName: null,
        assigneeEmail: null,
      };
      const where = jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([ticketRow]),
        }),
      });
      const leftJoin2 = jest.fn().mockReturnValue({ where });
      const leftJoin = jest.fn().mockReturnValue({ leftJoin: leftJoin2 });
      const from = jest.fn().mockReturnValue({ leftJoin });
      const db = {
        select: jest.fn().mockReturnValue({ from }),
      } as unknown as Db;
      const svc = makeTransferSvc(read, db);
      const result = await svc.exportTickets(
        { orgId: OWNER_ORG, userId: "u-owner" } as Parameters<typeof svc.exportTickets>[0],
        42,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ title: "Fix bug" });
      expect(result.truncated).toBe(false);
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER_ORG);
    });
  });
});

describe("ProjectsTicketsQueryService — cross-tenant isolation", () => {
  async function makeQuerySvc(db: Db): Promise<ProjectsTicketsQueryService> {
    const module = await Test.createTestingModule({ providers: [
      ProjectsTicketsQueryService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: {} },
      { provide: AccessService, useValue: {} },
      { provide: ProjectsWebhooksDispatchService, useValue: {} },
      { provide: BuildAutomationRunnerService, useValue: {} },
      { provide: ProjectsActivityService, useValue: {} },
      { provide: NotificationDispatchService, useValue: {} },
    ] }).compile();
    return module.get(ProjectsTicketsQueryService);
  }

  describe("validateTicketStatus", () => {
    it("throws ProjectsInvalidTicketStatusException when status is not valid (DENY)", async () => {
      mockResolveValidTicketStatuses.mockResolvedValue(new Set(["TODO", "IN_PROGRESS"]));
      const db = {} as unknown as Db;
      const svc = await makeQuerySvc(db);
      await expect(
        svc.validateTicketStatus(10, ATTACKER_ORG, "UNKNOWN_STATUS"),
      ).rejects.toThrow(ProjectsInvalidTicketStatusException);
    });

    it("passes orgId to resolveValidTicketStatuses (predicate check — DENY)", async () => {
      mockResolveValidTicketStatuses.mockResolvedValue(new Set(["TODO"]));
      const db = {} as unknown as Db;
      const svc = await makeQuerySvc(db);
      await expect(svc.validateTicketStatus(10, ATTACKER_ORG, "INVALID")).rejects.toThrow(
        ProjectsInvalidTicketStatusException,
      );
      expect(mockResolveValidTicketStatuses).toHaveBeenCalledWith(db, 10, ATTACKER_ORG);
    });

    it("resolves when status exists in the project (CONTROL)", async () => {
      mockResolveValidTicketStatuses.mockResolvedValue(
        new Set(["TODO", "IN_PROGRESS", "CUSTOM_STATUS"]),
      );
      const db = {} as unknown as Db;
      const svc = await makeQuerySvc(db);
      await expect(
        svc.validateTicketStatus(10, OWNER_ORG, "CUSTOM_STATUS"),
      ).resolves.toBeUndefined();
    });
  });
});
