import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { IncidentsService } from "./incidents.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

function makeAccess(perms: Set<string> = new Set()): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(perms),
  } as unknown as AccessService;
}

function makeUser(orgId: string, userId = "user-1"): CurrentUserContext {
  return {
    userId,
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, false),
  };
}

function makeSelectChain(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  jest.resetAllMocks();
});

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

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "investigating" });

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

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "mitigating" });

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

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "resolved" });

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

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "postmortem" });

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

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "resolved" });

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

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "detected" });

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

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    const result = await svc.getIncident(makeUser("org-1"), 1, 1);

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

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    const result = await svc.getIncident(makeUser("org-1"), 1, 1);

    expect(result.updates).toEqual([]);
    expect(result).toHaveProperty("status", "detected");
  });

  it("throws NotFoundException when the incident is not found", async () => {
    const mockDb = {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    await expect(svc.getIncident(makeUser("org-1"), 1, 999)).rejects.toThrow(NotFoundException);
  });
});

describe("IncidentsService — project-membership gate (BOLA)", () => {
  const u = makeUser("org-1");

  it("REJECTS a non-member with ForbiddenException", async () => {
    const mockDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        projectIncidents: { findFirst: jest.fn() },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    } as unknown as Db;
    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);

    await expect(svc.listIncidents(u, 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("ALLOWS a direct project member", async () => {
    const mockDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        projectIncidents: { findFirst: jest.fn() },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
        .mockReturnValueOnce(makeSelectChain([])),
    } as unknown as Db;
    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);

    await expect(svc.listIncidents(u, 1, {})).resolves.toEqual([]);
  });
});
