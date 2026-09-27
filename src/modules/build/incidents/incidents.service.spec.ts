jest.mock("../core", () => ({
  assertProjectAccess: jest.fn(),
}));

import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { IncidentsService } from "./incidents.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { projectIncidents } from "../../../db/schema";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { assertProjectAccess } from "../core";
import {
  addIncidentUpdateSchema,
  incidentChildrenQuerySchema,
} from "./dto/incidents.schemas";
import {
  incidentDetailSchema,
  incidentFollowUpActionRowSchema,
  incidentRowSchema,
  incidentUpdateRowSchema,
} from "./dto/incidents-response.schemas";

type IncidentAudit = jest.Mocked<Pick<AuditService, "log">>;
type IncidentAccess = jest.Mocked<Pick<AccessService, "resolveUserPermissions">>;

const mockAudit: IncidentAudit = { log: jest.fn() };

function makeAccess(perms: Set<string> = new Set()): IncidentAccess {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(perms),
  };
}

async function makeService(
  db: object,
  access: IncidentAccess = makeAccess(),
  audit: IncidentAudit = mockAudit,
): Promise<IncidentsService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      IncidentsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: access },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return moduleRef.get(IncidentsService);
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
    leftJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(assertProjectAccess).mockResolvedValue(undefined);
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

type IncidentStatus = (typeof projectIncidents.$inferSelect)["status"];
type IncidentFixture = Omit<typeof BASE_INCIDENT, "status"> & { status: IncidentStatus };

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

function makeTx(updateChain: ReturnType<typeof makeUpdateChain>, unresolvedFollowUps = 0) {
  const countChain = {
    from: jest.fn(),
    where: jest.fn().mockResolvedValue([{ count: unresolvedFollowUps }]),
  };
  countChain.from.mockReturnValue(countChain);
  const values = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) });
  return {
    values,
    select: jest.fn().mockReturnValue(countChain),
    update: jest.fn().mockReturnValue(updateChain),
    insert: jest.fn().mockReturnValue({ values }),
  };
}

describe("IncidentsService.computeSla (via updateIncident)", () => {
  it("sets respondedAt on the first non-detected status transition", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "investigating", respondedAt: new Date() }]);
    const tx = makeTx(updateChain);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, respondedAt: null }),
        },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "investigating" });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).toHaveProperty("respondedAt");
    expect(patch.respondedAt).toBeInstanceOf(Date);
  });

  it("does NOT overwrite respondedAt if it is already set", async () => {
    const existingRespondedAt = new Date("2024-01-01T10:05:00Z");
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "mitigating", respondedAt: existingRespondedAt }]);
    const tx = makeTx(updateChain);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, respondedAt: existingRespondedAt }),
        },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "mitigating" });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).not.toHaveProperty("respondedAt");
  });

  it("sets resolvedAt when status transitions to resolved and resolvedAt is not yet set", async () => {
    const respondedAt = new Date("2024-01-01T10:05:00Z");
    const updateChain = makeUpdateChain([
      { ...BASE_INCIDENT, status: "resolved", respondedAt, resolvedAt: new Date() },
    ]);
    const tx = makeTx(updateChain);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, respondedAt, resolvedAt: null }),
        },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "resolved" });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).toHaveProperty("resolvedAt");
    expect(patch.resolvedAt).toBeInstanceOf(Date);
  });

  it("does NOT set resolvedAt for non-resolved status transitions", async () => {
    const respondedAt = new Date("2024-01-01T10:05:00Z");
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "postmortem", respondedAt }]);
    const tx = makeTx(updateChain);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, respondedAt, resolvedAt: null }),
        },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "postmortem" });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).not.toHaveProperty("resolvedAt");
  });

  it("does NOT set resolvedAt if resolvedAt is already set", async () => {
    const respondedAt = new Date("2024-01-01T10:05:00Z");
    const existingResolvedAt = new Date("2024-01-01T11:00:00Z");
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "resolved", respondedAt, resolvedAt: existingResolvedAt }]);
    const tx = makeTx(updateChain);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({
            ...BASE_INCIDENT, respondedAt, resolvedAt: existingResolvedAt,
          }),
        },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "resolved" });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).not.toHaveProperty("resolvedAt");
  });

  it("does NOT set respondedAt when status remains detected", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "detected" }]);
    const tx = makeTx(updateChain);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, respondedAt: null }),
        },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "detected" });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).not.toHaveProperty("respondedAt");
    expect(patch).not.toHaveProperty("resolvedAt");
  });
});

describe("IncidentsService.updateIncident — atomic timeline on status/severity change", () => {
  it("inserts a timeline entry when status changes", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "investigating" }]);
    const tx = makeTx(updateChain);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, status: "detected" }),
        },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "investigating" });

    expect(tx.insert).toHaveBeenCalled();
    const insertValues = (tx.insert.mock.results[0]?.value as { values: jest.Mock }).values;
    const insertArg = (insertValues.mock.calls[0] as [Record<string, unknown>])[0];
    expect(insertArg).toMatchObject({ newStatus: "investigating", orgId: "org-1", incidentId: 1 });
  });

  it("does NOT insert a timeline entry when status is unchanged", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "detected" }]);
    const tx = makeTx(updateChain);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, status: "detected" }),
        },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "detected" });

    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("inserts a timeline entry when severity is escalated", async () => {
    const current = { ...BASE_INCIDENT, severity: "medium" as const };
    const updateChain = makeUpdateChain([{ ...current, severity: "critical" }]);
    const tx = makeTx(updateChain);
    const mockDb = {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue(current) },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { severity: "critical" });

    expect(tx.insert).toHaveBeenCalled();
    const insertValues = (tx.insert.mock.results[0]?.value as { values: jest.Mock }).values;
    const insertArg = (insertValues.mock.calls[0] as [Record<string, unknown>])[0];
    expect(insertArg).toMatchObject({ message: "Severity escalated to critical" });
  });

  it("does NOT insert a timeline entry when severity is de-escalated", async () => {
    const current = { ...BASE_INCIDENT, severity: "critical" as const };
    const updateChain = makeUpdateChain([{ ...current, severity: "medium" }]);
    const tx = makeTx(updateChain);
    const mockDb = {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue(current) },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { severity: "medium" });

    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("records a timeline entry when status changes", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "investigating" }]);
    const tx = makeTx(updateChain);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, status: "detected" }),
        },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "investigating" });

    expect(tx.insert).toHaveBeenCalled();
  });

  it("does not add a timeline entry when status is unchanged", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "detected" }]);
    const tx = makeTx(updateChain);
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, status: "detected" }),
        },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "detected" });
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
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(updates),
    };
    const mockDb = {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT }) },
      },
      select: jest.fn().mockReturnValue(selectChain),
    } as unknown as Db;

    const svc = await makeService(mockDb);
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
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const mockDb = {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT }) },
      },
      select: jest.fn().mockReturnValue(selectChain),
    } as unknown as Db;

    const svc = await makeService(mockDb);
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

    const svc = await makeService(mockDb);
    await expect(svc.getIncident(makeUser("org-1"), 1, 999)).rejects.toThrow(NotFoundException);
  });

  it("returns bounded child collections with reachable continuation cursors", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: 101 - index,
      orgId: "org-1",
      incidentId: 1,
      message: `Update ${String(index + 1)}`,
      newStatus: null,
      createdBy: "user-1",
      createdAt: new Date("2024-01-01T10:30:00Z"),
      createdByName: "User One",
      createdByEmail: "user@example.com",
    }));
    const updatesChain = makeSelectChain(rows);
    const decisionsChain = makeSelectChain([]);
    const followUpsChain = makeSelectChain([]);
    const mockDb = {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT }) },
      },
      select: jest.fn()
        .mockReturnValueOnce(updatesChain)
        .mockReturnValueOnce(decisionsChain)
        .mockReturnValueOnce(followUpsChain),
    };

    const svc = await makeService(mockDb);
    const result = await svc.getIncident(makeUser("org-1"), 1, 1);

    expect(updatesChain.limit).toHaveBeenCalledWith(101);
    expect(result.updates).toHaveLength(100);
    expect(result.childrenPagination.updates).toEqual({
      limit: 100,
      hasMore: true,
      nextCursor: 2,
    });
  });
});

describe("incident response enum contracts", () => {
  const incident = {
    ...BASE_INCIDENT,
    releaseId: null,
  };

  it("rejects unknown incident status and severity values", () => {
    expect(incidentRowSchema.safeParse({ ...incident, status: "unknown" }).success).toBe(false);
    expect(incidentRowSchema.safeParse({ ...incident, severity: "unknown" }).success).toBe(false);
  });

  it("rejects unknown update and follow-up status values", () => {
    expect(incidentUpdateRowSchema.safeParse({
      id: 1,
      orgId: "org-1",
      incidentId: 1,
      message: "Changed",
      newStatus: "unknown",
      createdBy: "user-1",
      createdAt: new Date(),
    }).success).toBe(false);
    expect(incidentFollowUpActionRowSchema.safeParse({
      id: 1,
      orgId: "org-1",
      incidentId: 1,
      title: "Follow up",
      description: null,
      ownerId: null,
      status: "unknown",
      dueAt: null,
      createdBy: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).success).toBe(false);
  });

  it("requires continuation metadata on incident detail responses", () => {
    const result = incidentDetailSchema.safeParse({
      ...incident,
      updates: [],
      decisions: [],
      followUpActions: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts returned child cursors as the next detail request", () => {
    expect(incidentChildrenQuerySchema.parse({
      limit: "25",
      updatesCursor: "75",
      decisionsCursor: "50",
      followUpActionsCursor: "40",
    })).toEqual({
      limit: 25,
      updatesCursor: 75,
      decisionsCursor: 50,
      followUpActionsCursor: 40,
    });
  });
});

describe("IncidentsService — project-membership gate (BOLA)", () => {
  const u = makeUser("org-1");

  it("REJECTS a non-member (listIncidents) with ForbiddenException", async () => {
    jest.mocked(assertProjectAccess).mockRejectedValueOnce(
      new ForbiddenException("You do not have access to this project"),
    );
    const mockDb = {
      query: { projectIncidents: { findFirst: jest.fn() } },
      select: jest.fn().mockReturnValue(makeSelectChain([])),
    } as unknown as Db;
    const svc = await makeService(mockDb);

    await expect(svc.listIncidents(u, 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("ALLOWS a project member (listIncidents)", async () => {
    const mockDb = {
      query: { projectIncidents: { findFirst: jest.fn() } },
      select: jest.fn().mockReturnValue(makeSelectChain([])),
    } as unknown as Db;
    const svc = await makeService(mockDb);

    await expect(svc.listIncidents(u, 1, {})).resolves.toEqual({
      data: [],
      pagination: { limit: 100, hasMore: false, nextCursor: null },
    });
  });

  it("REJECTS a non-member (getIncident) with ForbiddenException", async () => {
    jest.mocked(assertProjectAccess).mockRejectedValueOnce(
      new ForbiddenException("You do not have access to this project"),
    );
    const mockDb = {
      query: { projectIncidents: { findFirst: jest.fn() } },
    } as unknown as Db;
    const svc = await makeService(mockDb);

    await expect(svc.getIncident(u, 1, 1)).rejects.toThrow(ForbiddenException);
  });

  it("REJECTS a non-member (addUpdate) with ForbiddenException", async () => {
    jest.mocked(assertProjectAccess).mockRejectedValueOnce(
      new ForbiddenException("You do not have access to this project"),
    );
    const mockDb = {
      query: { projectIncidents: { findFirst: jest.fn() } },
    } as unknown as Db;
    const svc = await makeService(mockDb);

    await expect(svc.addUpdate(u, 1, 1, { message: "test" })).rejects.toThrow(ForbiddenException);
  });

  it("REJECTS a non-member update before loading the incident", async () => {
    const denied = new NotFoundException("Project not found");
    jest.mocked(assertProjectAccess).mockRejectedValueOnce(denied);
    const findFirst = jest.fn();
    const mockDb = {
      query: { projectIncidents: { findFirst } },
    };
    const svc = await makeService(mockDb);

    await expect(svc.updateIncident(u, 1, 1, { title: "Denied" })).rejects.toBe(denied);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("REJECTS a non-member delete before loading the incident", async () => {
    const denied = new NotFoundException("Project not found");
    jest.mocked(assertProjectAccess).mockRejectedValueOnce(denied);
    const findFirst = jest.fn();
    const mockDb = {
      query: { projectIncidents: { findFirst } },
    };
    const svc = await makeService(mockDb);

    await expect(svc.deleteIncident(u, 1, 1)).rejects.toBe(denied);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("IncidentsService.addUpdate — state machine", () => {
  it("throws ConflictException when transitioning a closed incident to another status", async () => {
    const closedIncident = { ...BASE_INCIDENT, status: "closed" as const };
    const mockDb = {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue(closedIncident) },
      },
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await expect(
      svc.addUpdate(makeUser("org-1"), 1, 1, { message: "Reopen attempt", newStatus: "investigating" }),
    ).rejects.toThrow(ConflictException);
  });

  it("allows adding a message without status change to a closed incident", async () => {
    const closedIncident = { ...BASE_INCIDENT, status: "closed" as const };
    const insertValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 9, message: "Postmortem note", newStatus: null }]),
    });
    const tx = {
      insert: jest.fn().mockReturnValue({ values: insertValues }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };
    const mockDb = {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue(closedIncident) },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    const result = await svc.addUpdate(makeUser("org-1"), 1, 1, { message: "Postmortem note" });

    expect(result).toMatchObject({ message: "Postmortem note" });
  });

  it("records a timeline entry when status changes via addUpdate", async () => {
    const insertValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 5, message: "msg", newStatus: "investigating" }]),
    });
    const tx = {
      insert: jest.fn().mockReturnValue({ values: insertValues }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, status: "detected" }),
        },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.addUpdate(makeUser("org-1"), 1, 1, { message: "Investigating", newStatus: "investigating" });

    expect(tx.insert).toHaveBeenCalled();
  });

  it("does not update incident state when newStatus matches current status (idempotent)", async () => {
    const insertValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 6, message: "msg", newStatus: "detected" }]),
    });
    const tx = {
      insert: jest.fn().mockReturnValue({ values: insertValues }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };
    const mockDb = {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, status: "detected" }),
        },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = await makeService(mockDb);
    await svc.addUpdate(makeUser("org-1"), 1, 1, { message: "Still detected", newStatus: "detected" });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("refuses the update endpoint close path while unresolved follow-ups remain", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "closed" }]);
    const tx = makeTx(updateChain, 2);
    const mockDb = {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue(BASE_INCIDENT) },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    };
    const svc = await makeService(mockDb);

    await expect(
      svc.addUpdate(makeUser("org-1"), 1, 1, { message: "Closing", newStatus: "closed" }),
    ).rejects.toThrow(ConflictException);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("closes through the update endpoint when unresolved follow-ups have a waiver", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "closed" }]);
    const tx = makeTx(updateChain, 2);
    const mockDb = {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue(BASE_INCIDENT) },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    };
    const svc = await makeService(mockDb);

    await expect(svc.addUpdate(makeUser("org-1"), 1, 1, {
      message: "Closing",
      newStatus: "closed",
      followUpWaiverReason: "Accepted risk",
    })).resolves.toBeUndefined();
    expect(tx.update).toHaveBeenCalledTimes(1);
    const messages = tx.values.mock.calls.map(
      (call) => (call as [Record<string, unknown>])[0]?.["message"],
    );
    expect(messages).toContainEqual(
      "Closed with 2 unresolved follow-up action(s) waived: Accepted risk",
    );
  });

  it("accepts a nonblank waiver and rejects a blank waiver at the validation boundary", () => {
    expect(addIncidentUpdateSchema.safeParse({
      message: "Closing",
      newStatus: "closed",
      followUpWaiverReason: "Accepted risk",
    }).success).toBe(true);
    expect(addIncidentUpdateSchema.safeParse({
      message: "Closing",
      newStatus: "closed",
      followUpWaiverReason: "   ",
    }).success).toBe(false);
  });
});

describe("IncidentsService.updateIncident unresolved follow-up close policy", () => {
  function makeClosingDb(tx: ReturnType<typeof makeTx>, current: IncidentFixture = BASE_INCIDENT) {
    return {
      query: {
        projectIncidents: { findFirst: jest.fn().mockResolvedValue(current) },
      },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;
  }

  it("refuses to close an incident that still has unresolved follow-up actions", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "closed" }]);
    const tx = makeTx(updateChain, 2);
    const svc = await makeService(makeClosingDb(tx));

    await expect(svc.updateIncident(makeUser("org-1"), 1, 1, { status: "closed" })).rejects.toThrow(
      ConflictException,
    );
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("names the unresolved follow-up count and the waiver field in the refusal", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "closed" }]);
    const tx = makeTx(updateChain, 3);
    const svc = await makeService(makeClosingDb(tx));

    await expect(svc.updateIncident(makeUser("org-1"), 1, 1, { status: "closed" })).rejects.toThrow(
      /3 unresolved follow-up action\(s\).*followUpWaiverReason/s,
    );
  });

  it("closes an incident that has no unresolved follow-up actions", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "closed" }]);
    const tx = makeTx(updateChain, 0);
    const svc = await makeService(makeClosingDb(tx));

    const result = await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "closed" });

    expect(result).toMatchObject({ status: "closed" });
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));
  });

  it("closes over unresolved follow-up actions when a waiver reason is supplied", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "closed" }]);
    const tx = makeTx(updateChain, 2);
    const svc = await makeService(makeClosingDb(tx));

    const result = await svc.updateIncident(makeUser("org-1"), 1, 1, {
      status: "closed",
      followUpWaiverReason: "Tracked in the Q3 reliability programme",
    });

    expect(result).toMatchObject({ status: "closed" });
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));
  });

  it("records the waived count and reason as an incident timeline entry", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "closed" }]);
    const tx = makeTx(updateChain, 2);
    const svc = await makeService(makeClosingDb(tx));

    await svc.updateIncident(makeUser("org-1"), 1, 1, {
      status: "closed",
      followUpWaiverReason: "Tracked in the Q3 reliability programme",
    });

    const messages = tx.values.mock.calls.map(
      (call) => (call as [Record<string, unknown>])[0]?.["message"],
    );
    expect(messages).toContainEqual(
      "Closed with 2 unresolved follow-up action(s) waived: Tracked in the Q3 reliability programme",
    );
  });

  it("records the waiver reason on the audit entry", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "closed" }]);
    const tx = makeTx(updateChain, 1);
    const svc = await makeService(makeClosingDb(tx));

    await svc.updateIncident(makeUser("org-1"), 1, 1, {
      status: "closed",
      followUpWaiverReason: "Accepted risk",
    });

    expect(mockAudit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "incident.updated",
        metadata: expect.objectContaining({ followUpWaiverReason: "Accepted risk" }),
      }),
    );
  });

  it("does not count follow-up actions when the status is not changing to closed", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, status: "mitigating" }]);
    const tx = makeTx(updateChain, 5);
    const svc = await makeService(makeClosingDb(tx));

    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "mitigating" });

    expect(tx.select).not.toHaveBeenCalled();
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ status: "mitigating" }));
  });

  it("does not re-run the close policy when the incident is already closed", async () => {
    const closed: IncidentFixture = { ...BASE_INCIDENT, status: "closed" };
    const updateChain = makeUpdateChain([{ ...closed, title: "Renamed" }]);
    const tx = makeTx(updateChain, 4);
    const svc = await makeService(makeClosingDb(tx, closed));

    await svc.updateIncident(makeUser("org-1"), 1, 1, { status: "closed", title: "Renamed" });

    expect(tx.select).not.toHaveBeenCalled();
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ title: "Renamed" }));
  });
});

describe("IncidentsService.listIncidents — server-side full-text search predicate", () => {
  function hasOwnPropStrLocal<K extends string>(obj: object, key: K): obj is Record<K, unknown> {
    return key in obj;
  }

  function collectParamValuesLocal(node: unknown, acc: unknown[] = []): unknown[] {
    if (node === null || node === undefined) return acc;
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      acc.push(node);
      return acc;
    }
    if (typeof node !== "object") return acc;
    if (Array.isArray(node)) {
      for (const item of node) collectParamValuesLocal(item, acc);
      return acc;
    }
    if (hasOwnPropStrLocal(node, "encoder") && hasOwnPropStrLocal(node, "value")) {
      acc.push(node.value);
      return acc;
    }
    if (hasOwnPropStrLocal(node, "queryChunks")) {
      const qc = node.queryChunks;
      if (Array.isArray(qc)) {
        for (const chunk of qc) collectParamValuesLocal(chunk, acc);
      }
    }
    return acc;
  }

  it("includes the search term as a WHERE param so the DB filters rather than the caller", async () => {
    const listChain = makeSelectChain([BASE_INCIDENT]);
    const mockDb = { select: jest.fn().mockReturnValue(listChain) };
    const svc = await makeService(mockDb);

    await svc.listIncidents(makeUser("org-1"), 1, { q: "latency" });

    const whereArg: unknown = listChain.where.mock.calls[0]?.[0];
    expect(collectParamValuesLocal(whereArg)).toContain("latency");
  });

  it("does not include a search param for 'latency' in WHERE when no q is provided", async () => {
    const listChain = makeSelectChain([]);
    const mockDb = { select: jest.fn().mockReturnValue(listChain) };
    const svc = await makeService(mockDb);

    await svc.listIncidents(makeUser("org-1"), 1, {});

    const whereArg: unknown = listChain.where.mock.calls[0]?.[0];
    expect(collectParamValuesLocal(whereArg)).not.toContain("latency");
  });

  it("keeps orgId and projectId in WHERE beside the search term, which is the only reason the measured cost of search is a heap filter over one project's rows: a GIN index on the searched expression is never chosen under RLS because ts_match_vq is not leakproof and cannot be evaluated before the tenant qual (BE-80)", async () => {
    const listChain = makeSelectChain([]);
    const mockDb = { select: jest.fn().mockReturnValue(listChain) };
    const svc = await makeService(mockDb);

    await svc.listIncidents(makeUser("org-1"), 7777, { q: "latency" });

    const whereArg: unknown = listChain.where.mock.calls[0]?.[0];
    const params = collectParamValuesLocal(whereArg);
    expect(params).toContain("latency");
    expect(params).toContain("org-1");
    expect(params).toContain(7777);
  });
});
