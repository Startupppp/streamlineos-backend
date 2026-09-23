jest.mock("../core/project-access", () => ({
  assertProjectAccess: jest.fn(),
}));

jest.mock("../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn() },
}));

import { NotFoundException } from "@nestjs/common";
import { IncidentsService } from "./incidents.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { assertProjectAccess } from "../core/project-access";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

function makeAccess(): AccessService {
  return { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
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

const BASE_INCIDENT = {
  id: 1,
  orgId: "org-1",
  projectId: 1,
  incidentNumber: 1,
  title: "DB latency spike",
  description: null,
  severity: "high" as const,
  status: "closed" as const,
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
  releaseId: null,
  createdBy: "user-1",
  createdAt: new Date("2024-01-01T10:00:00Z"),
  updatedAt: new Date("2024-01-01T10:00:00Z"),
};

function makeUpdateChain(returning: Record<string, unknown>[]) {
  const chain = { set: jest.fn(), where: jest.fn(), returning: jest.fn().mockResolvedValue(returning) };
  chain.set.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(assertProjectAccess).mockResolvedValue(undefined);
});

describe("IncidentsService — postmortem field round-trip: releaseId", () => {
  it("createIncident writes the supplied releaseId and returns it on the created row", async () => {
    const selectChain = { from: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue([{ maxNum: 0 }]) };
    const insertValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ ...BASE_INCIDENT, releaseId: 55 }]),
    });
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue(selectChain),
      insert: jest.fn().mockReturnValue({ values: insertValues }),
    };
    const mockDb = {
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    const created = await svc.createIncident(makeUser("org-1"), 1, { title: "DB latency spike", releaseId: 55 });

    const insertArg = (insertValues.mock.calls[0] as [Record<string, unknown>])[0];
    expect(insertArg).toMatchObject({ releaseId: 55 });
    expect(created).toMatchObject({ releaseId: 55 });
  });

  it("createIncident defaults releaseId to null when the input omits it", async () => {
    const selectChain = { from: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue([{ maxNum: 0 }]) };
    const insertValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ ...BASE_INCIDENT, releaseId: null }]),
    });
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue(selectChain),
      insert: jest.fn().mockReturnValue({ values: insertValues }),
    };
    const mockDb = {
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    await svc.createIncident(makeUser("org-1"), 1, { title: "DB latency spike" });

    const insertArg = (insertValues.mock.calls[0] as [Record<string, unknown>])[0];
    expect(insertArg).toMatchObject({ releaseId: null });
  });

  it("updateIncident round-trips releaseId through the patch", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, releaseId: 77 }]);
    const tx = {
      update: jest.fn().mockReturnValue(updateChain),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
    };
    const mockDb = {
      query: { projectIncidents: { findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, releaseId: null }) } },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    const updated = await svc.updateIncident(makeUser("org-1"), 1, 1, { releaseId: 77 });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).toMatchObject({ releaseId: 77 });
    expect(updated).toMatchObject({ releaseId: 77 });
  });

  it("updateIncident clears releaseId to null when explicitly unset", async () => {
    const updateChain = makeUpdateChain([{ ...BASE_INCIDENT, releaseId: null }]);
    const tx = {
      update: jest.fn().mockReturnValue(updateChain),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
    };
    const mockDb = {
      query: { projectIncidents: { findFirst: jest.fn().mockResolvedValue({ ...BASE_INCIDENT, releaseId: 77 }) } },
      transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    await svc.updateIncident(makeUser("org-1"), 1, 1, { releaseId: null });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).toMatchObject({ releaseId: null });
  });
});

describe("IncidentsService — postmortem field round-trip: decisions", () => {
  it("addDecision writes and returns the decision and rationale", async () => {
    const insertValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([
        { id: 1, orgId: "org-1", incidentId: 1, decision: "Roll back the deploy", rationale: "Fastest mitigation", decidedBy: "user-1", createdAt: new Date() },
      ]),
    });
    const mockDb = {
      query: { projectIncidents: { findFirst: jest.fn().mockResolvedValue(BASE_INCIDENT) } },
      insert: jest.fn().mockReturnValue({ values: insertValues }),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    const decision = await svc.addDecision(makeUser("org-1"), 1, 1, {
      decision: "Roll back the deploy",
      rationale: "Fastest mitigation",
    });

    const insertArg = (insertValues.mock.calls[0] as [Record<string, unknown>])[0];
    expect(insertArg).toMatchObject({
      orgId: "org-1",
      incidentId: 1,
      decision: "Roll back the deploy",
      rationale: "Fastest mitigation",
      decidedBy: "user-1",
    });
    expect(decision).toMatchObject({ decision: "Roll back the deploy", rationale: "Fastest mitigation" });
  });

  it("addDecision defaults rationale to null when omitted", async () => {
    const insertValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 2, decision: "Escalated to on-call", rationale: null }]),
    });
    const mockDb = {
      query: { projectIncidents: { findFirst: jest.fn().mockResolvedValue(BASE_INCIDENT) } },
      insert: jest.fn().mockReturnValue({ values: insertValues }),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    await svc.addDecision(makeUser("org-1"), 1, 1, { decision: "Escalated to on-call" });

    const insertArg = (insertValues.mock.calls[0] as [Record<string, unknown>])[0];
    expect(insertArg).toMatchObject({ rationale: null });
  });
});

describe("IncidentsService — postmortem field round-trip: follow-up actions", () => {
  it("addFollowUpAction writes and returns title/owner/dueAt", async () => {
    const dueAt = new Date("2024-02-01T00:00:00Z");
    const insertValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([
        { id: 1, orgId: "org-1", incidentId: 1, title: "Add a landed-cost clearing account", description: null, ownerId: "user-2", status: "open", dueAt, createdBy: "user-1" },
      ]),
    });
    const mockDb = {
      query: { projectIncidents: { findFirst: jest.fn().mockResolvedValue(BASE_INCIDENT) } },
      insert: jest.fn().mockReturnValue({ values: insertValues }),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    const action = await svc.addFollowUpAction(makeUser("org-1"), 1, 1, {
      title: "Add a landed-cost clearing account",
      ownerId: "user-2",
      dueAt,
    });

    const insertArg = (insertValues.mock.calls[0] as [Record<string, unknown>])[0];
    expect(insertArg).toMatchObject({ title: "Add a landed-cost clearing account", ownerId: "user-2", dueAt });
    expect(insertArg).not.toHaveProperty("status"); // left to the DB default ('open'), not set explicitly on create
    expect(action).toMatchObject({ title: "Add a landed-cost clearing account", ownerId: "user-2", status: "open", dueAt });
  });

  it("updateFollowUpAction round-trips a status transition and owner reassignment", async () => {
    const updateChain = makeUpdateChain([
      { id: 1, orgId: "org-1", incidentId: 1, title: "Add a landed-cost clearing account", ownerId: "user-3", status: "in_progress", dueAt: null },
    ]);
    const mockDb = {
      query: { projectIncidents: { findFirst: jest.fn().mockResolvedValue(BASE_INCIDENT) } },
      update: jest.fn().mockReturnValue(updateChain),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    const updated = await svc.updateFollowUpAction(makeUser("org-1"), 1, 1, 1, {
      status: "in_progress",
      ownerId: "user-3",
    });

    const patch = (updateChain.set.mock.calls[0] as [Record<string, unknown>])[0];
    expect(patch).toMatchObject({ status: "in_progress", ownerId: "user-3" });
    expect(updated).toMatchObject({ status: "in_progress", ownerId: "user-3" });
  });

  it("updateFollowUpAction throws NotFoundException when no row matches (cross-tenant or unknown id)", async () => {
    const updateChain = makeUpdateChain([]);
    const mockDb = {
      query: { projectIncidents: { findFirst: jest.fn().mockResolvedValue(BASE_INCIDENT) } },
      update: jest.fn().mockReturnValue(updateChain),
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    await expect(
      svc.updateFollowUpAction(makeUser("org-1"), 1, 1, 999, { status: "done" }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("IncidentsService.getIncident — includes decisions and follow-up actions", () => {
  it("returns decisions and followUpActions arrays alongside updates", async () => {
    const updatesChain = {
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const decisionsChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ id: 1, decision: "Roll back the deploy", rationale: null }]),
    };
    const followUpsChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ id: 1, title: "Add a landed-cost clearing account", status: "open" }]),
    };
    const select = jest.fn()
      .mockReturnValueOnce(updatesChain)
      .mockReturnValueOnce(decisionsChain)
      .mockReturnValueOnce(followUpsChain);

    const mockDb = {
      query: { projectIncidents: { findFirst: jest.fn().mockResolvedValue(BASE_INCIDENT) } },
      select,
    } as unknown as Db;

    const svc = new IncidentsService(mockDb, makeAccess(), mockAudit);
    const result = await svc.getIncident(makeUser("org-1"), 1, 1);

    expect(result.decisions).toEqual([{ id: 1, decision: "Roll back the deploy", rationale: null }]);
    expect(result.followUpActions).toEqual([{ id: 1, title: "Add a landed-cost clearing account", status: "open" }]);
  });
});
