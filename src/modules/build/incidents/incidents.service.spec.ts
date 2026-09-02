import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { IncidentsService } from "./incidents.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => {
  jest.resetAllMocks();
});

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 100, isOrgOwner: false },
    ...overrides,
  };
}

function makeSelectChain(resolved: unknown[]) {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(resolved),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

const mockAccessNoPerms = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
} as unknown as AccessService;

const BASE_INCIDENT = {
  id: 1,
  orgId: "org-1",
  projectId: 1,
  incidentNumber: 1,
  title: "DB latency spike",
  description: null,
  severity: "high" as const,
  status: "detected" as const,
  respondedAt: null,
  resolvedAt: null,
  deletedAt: null,
  impact: null,
  ownerId: null,
  rootCause: null,
  customerComms: null,
  detectedAt: new Date("2024-01-01T10:00:00Z"),
  responseDueAt: null,
  resolutionDueAt: null,
  linkedTicketId: null,
  createdBy: "user-1",
  createdAt: new Date("2024-01-01T10:00:00Z"),
  updatedAt: new Date("2024-01-01T10:00:00Z"),
};

function makeUpdateChain(returning: Record<string, unknown>[] = []) {
  const chain = {
    set: jest.fn(),
    where: jest.fn(),
    returning: jest.fn().mockResolvedValue(returning),
  };
  chain.set.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

describe("IncidentsService.computeSla (via updateIncident)", () => {
  it("sets respondedAt on the first non-detected status transition", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "investigating", respondedAt: new Date() }]);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, respondedAt: null }),
        },
      },
      update: jest.fn().mockReturnValue(updateChain),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, mockAudit, mockAccessNoPerms);
    await svc.updateIncident("org-1", "user-1", 1, 1, { status: "investigating" });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).toHaveProperty("respondedAt");
    expect(patch.respondedAt).toBeInstanceOf(Date);
  });

  it("does NOT overwrite respondedAt if it is already set", async () => {
    const existingRespondedAt = new Date("2024-01-01T10:05:00Z");
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "mitigating", respondedAt: existingRespondedAt }]);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, respondedAt: existingRespondedAt }),
        },
      },
      update: jest.fn().mockReturnValue(updateChain),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, mockAudit, mockAccessNoPerms);
    await svc.updateIncident("org-1", "user-1", 1, 1, { status: "mitigating" });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).not.toHaveProperty("respondedAt");
  });

  it("sets resolvedAt when status transitions to resolved and resolvedAt is not yet set", async () => {
    const respondedAt = new Date("2024-01-01T10:05:00Z");
    const updateChain = makeUpdateChain([
      { ...BASE_INCIDENT, status: "resolved", respondedAt, resolvedAt: new Date() },
    ]);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, respondedAt, resolvedAt: null }),
        },
      },
      update: jest.fn().mockReturnValue(updateChain),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, mockAudit, mockAccessNoPerms);
    await svc.updateIncident("org-1", "user-1", 1, 1, { status: "resolved" });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).toHaveProperty("resolvedAt");
    expect(patch.resolvedAt).toBeInstanceOf(Date);
  });

  it("does NOT set resolvedAt for non-resolved status transitions", async () => {
    const respondedAt = new Date("2024-01-01T10:05:00Z");
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "postmortem", respondedAt }]);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, respondedAt, resolvedAt: null }),
        },
      },
      update: jest.fn().mockReturnValue(updateChain),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, mockAudit, mockAccessNoPerms);
    await svc.updateIncident("org-1", "user-1", 1, 1, { status: "postmortem" });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).not.toHaveProperty("resolvedAt");
  });

  it("does NOT set resolvedAt if resolvedAt is already set", async () => {
    const respondedAt = new Date("2024-01-01T10:05:00Z");
    const existingResolvedAt = new Date("2024-01-01T11:00:00Z");
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "resolved", respondedAt, resolvedAt: existingResolvedAt }]);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({
            ...BASE_INCIDENT, respondedAt, resolvedAt: existingResolvedAt,
          }),
        },
      },
      update: jest.fn().mockReturnValue(updateChain),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, mockAudit, mockAccessNoPerms);
    await svc.updateIncident("org-1", "user-1", 1, 1, { status: "resolved" });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).not.toHaveProperty("resolvedAt");
  });

  it("does NOT set respondedAt when status remains detected", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "detected" }]);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, respondedAt: null }),
        },
      },
      update: jest.fn().mockReturnValue(updateChain),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, mockAudit, mockAccessNoPerms);
    await svc.updateIncident("org-1", "user-1", 1, 1, { status: "detected" });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).not.toHaveProperty("respondedAt");
    expect(patch).not.toHaveProperty("resolvedAt");
  });
});

describe("IncidentsService.getIncident — flat response structure", () => {
  it("returns a flat object merging incident fields with an updates array", async () => {
    const updates = [
      {
        id: 10,
        incidentId: 1,
        message: "Identified root cause",
        newStatus: "investigating" as const,
        createdBy: "user-1",
        createdAt: new Date("2024-01-01T10:30:00Z"),
      },
    ];
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue(updates),
    };
    const mockDb = {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT }) },
      },
      select: jest.fn().mockReturnValue(selectChain),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, mockAudit, mockAccessNoPerms);
    const result = await svc.getIncident("org-1", 1, 1);

    expect(result).toMatchObject({ ...BASE_INCIDENT, updates });
    expect(result).toHaveProperty("id", 1);
    expect(result).toHaveProperty("title", "DB latency spike");
    expect(result).toHaveProperty("updates");
    expect(Array.isArray(result.updates)).toBe(true);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]).toMatchObject({ id: 10, message: "Identified root cause" });
  });

  it("returns an empty updates array when no updates exist", async () => {
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([]),
    };
    const mockDb = {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT }) },
      },
      select: jest.fn().mockReturnValue(selectChain),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, mockAudit, mockAccessNoPerms);
    const result = await svc.getIncident("org-1", 1, 1);

    expect(result.updates).toEqual([]);
    expect(result).toHaveProperty("status", "detected");
  });

  it("throws NotFoundException when the incident is not found", async () => {
    const mockDb = {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, mockAudit, mockAccessNoPerms);
    await expect(svc.getIncident("org-1", 1, 999)).rejects.toThrow(NotFoundException);
  });
});

describe("IncidentsService — assertProjectAccess gate BITES", () => {
  it("rejects a non-member caller with ForbiddenException", async () => {
    const project = { id: 1, orgId: "org-1", managerMembershipId: 999 };
    const mockAccess = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    } as unknown as AccessService;
    const mockDb = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue(project) } },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
      transaction: jest.fn(),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, mockAudit, mockAccess);
    await expect(
      svc.listIncidents(makeUser({ isOrgOwner: false, orgId: "org-1", userId: "user-1" }), 1, {}),
    ).rejects.toThrow(ForbiddenException);
    expect((mockDb as unknown as { transaction: jest.Mock }).transaction).not.toHaveBeenCalled();
  });

  it("allows a direct project member to list incidents", async () => {
    const project = { id: 1, orgId: "org-1", managerMembershipId: 999 };
    const mockAccess = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    } as unknown as AccessService;
    const mockDb = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue(project) } },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
        .mockReturnValueOnce(makeSelectChain([])),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, mockAudit, mockAccess);
    const result = await svc.listIncidents(
      makeUser({ isOrgOwner: false, orgId: "org-1", userId: "user-1" }),
      1,
      {},
    );
    expect(Array.isArray(result)).toBe(true);
  });
});
