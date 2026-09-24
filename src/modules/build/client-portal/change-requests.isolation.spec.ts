import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChangeRequestsService } from "./change-requests.service";
import { listCrQuerySchema } from "./dto/change-requests.schemas";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";

function makeU(orgId: string, isOrgOwner = false): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, isOrgOwner),
  };
}

function makeMockDb(changeRequestRow: unknown = undefined) {
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
      changeRequests: { findFirst: jest.fn().mockResolvedValue(changeRequestRow) },
    },
    select: jest.fn(),
    transaction: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  };
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;
const mockAccess = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
} as unknown as AccessService;

beforeEach(() => {
  jest.resetAllMocks();
  (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
});

describe("ChangeRequestsService — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when change request belongs to a different org", async () => {
    const db = makeMockDb(undefined);
    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    await expect(svc.getChangeRequest(makeU("org-attacker"), 1, 99)).rejects.toThrow(
      NotFoundException,
    );

    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("returns the change request when orgId matches", async () => {
    const crRow = {
      id: 1,
      orgId: "org-1",
      projectId: 1,
      crNumber: 1,
      title: "Add feature",
      status: "submitted",
      description: null,
      impact: null,
      estimateMinutes: null,
      budgetImpactCents: null,
      timelineImpactDays: null,
      requestedById: null,
      approvalOwnerId: null,
      approvalOwnerMembershipId: null,
      decisionComment: null,
      decidedAt: null,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([crRow]),
          }),
        }),
      }),
      transaction: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
    };

    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);
    const result = await svc.getChangeRequest(makeU("org-1", true), 1, 1);
    expect(result).toEqual(crRow);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("throws NotFoundException for project lookup with wrong org before listing change requests", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
        changeRequests: { findFirst: jest.fn() },
      },
      select: jest.fn(),
      transaction: jest.fn(),
    };

    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    await expect(
      svc.listChangeRequests(makeU("org-attacker"), 1, {}),
    ).rejects.toThrow(NotFoundException);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.query.changeRequests.findFirst).not.toHaveBeenCalled();
  });
});

describe("ChangeRequestsService — project membership gate (BOLA fix)", () => {
  const ORG = "org-1";
  const u = makeU(ORG);
  const gateAccess = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;

  function makeNonMemberDb() {
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
      },
      transaction: jest.fn(),
      select: jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
              }),
            }),
          }),
        }),
    };
  }

  function makeMemberDb(): Db {
    const postGateChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
      },
      select: jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([{ role: "MEMBER" }]),
              }),
            }),
          }),
        })
        .mockReturnValue(postGateChain),
    } as unknown as Db;
  }

  beforeEach(() => {
    (gateAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
  });

  it("rejects non-member with ForbiddenException on listChangeRequests", async () => {
    const db = makeNonMemberDb();
    const svc = new ChangeRequestsService(db as unknown as Db, gateAccess, mockAudit);
    await expect(svc.listChangeRequests(u, 1, {})).rejects.toThrow(ForbiddenException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("allows direct project member on listChangeRequests", async () => {
    const db = makeMemberDb();
    const svc = new ChangeRequestsService(db, gateAccess, mockAudit);

    await expect(svc.listChangeRequests(u, 1, {})).resolves.toBeDefined();
  });
});

describe("ChangeRequestsService — state machine transitions", () => {
  function makeDbWithExisting(existingRow: { id: number; status: string; requestedById: string | null }) {
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([existingRow]),
          }),
        }),
      }),
      update: jest.fn(),
      transaction: jest.fn(),
    };
  }

  it("rejects an illegal status transition from submitted to completed", async () => {
    const db = makeDbWithExisting({ id: 1, status: "submitted", requestedById: "user-1" });
    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    await expect(
      svc.updateChangeRequest(makeU("org-1", true), 1, 1, { status: "completed" }),
    ).rejects.toThrow(BadRequestException);

    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects transitioning from a terminal completed state", async () => {
    const db = makeDbWithExisting({ id: 1, status: "completed", requestedById: "user-1" });
    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    await expect(
      svc.updateChangeRequest(makeU("org-1", true), 1, 1, { status: "submitted" }),
    ).rejects.toThrow(BadRequestException);

    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects decide-after-withdraw (rejected back to approved) without the allowed path", async () => {
    const db = makeDbWithExisting({ id: 1, status: "rejected", requestedById: "user-1" });
    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    await expect(
      svc.updateChangeRequest(makeU("org-1", true), 1, 1, { status: "approved" }),
    ).rejects.toThrow(BadRequestException);

    expect(db.update).not.toHaveBeenCalled();
  });

  it("allows a legal state transition from submitted to under_review", async () => {
    const existingRow = { id: 1, status: "submitted", requestedById: "user-1" };
    const updatedRow = { ...existingRow, status: "under_review", title: "T", orgId: "org-1" };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([existingRow]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updatedRow]),
          }),
        }),
      }),
      transaction: jest.fn(),
    };
    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    const result = await svc.updateChangeRequest(makeU("org-1", true), 1, 1, {
      status: "under_review",
    });

    expect(result).toEqual(updatedRow);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("allows approve from awaiting_approval and sets decidedAt", async () => {
    const existingRow = {
      id: 1,
      status: "awaiting_approval",
      requestedById: "user-1",
    };
    const updatedRow = { ...existingRow, status: "approved", title: "T", orgId: "org-1" };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([existingRow]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updatedRow]),
          }),
        }),
      }),
      transaction: jest.fn(),
    };
    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    const result = await svc.updateChangeRequest(makeU("org-1", true), 1, 1, {
      status: "approved",
    });

    expect(result).toEqual(updatedRow);
    const setCall = (db.update().set as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(setCall).toHaveProperty("decidedAt");
    expect(setCall["decidedAt"]).toBeInstanceOf(Date);
  });
});

describe("ChangeRequestsService — soft-delete resurrection prevention", () => {
  it("updateChangeRequest throws NotFoundException when the CR was already soft-deleted", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      update: jest.fn(),
      transaction: jest.fn(),
    };
    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    await expect(
      svc.updateChangeRequest(makeU("org-1", true), 1, 1, { title: "New title" }),
    ).rejects.toThrow(NotFoundException);

    expect(db.update).not.toHaveBeenCalled();
  });

  it("deleteChangeRequest throws NotFoundException when the CR was already soft-deleted", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      update: jest.fn(),
      transaction: jest.fn(),
    };
    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    await expect(svc.deleteChangeRequest(makeU("org-1", true), 1, 1)).rejects.toThrow(
      NotFoundException,
    );

    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("ChangeRequestsService — project scope on mutations", () => {
  it("updateChangeRequest rejects a cross-project request with ForbiddenException", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn(),
      update: jest.fn(),
      transaction: jest.fn(),
    };
    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    await expect(
      svc.updateChangeRequest(makeU("org-attacker"), 1, 1, { title: "Hacked" }),
    ).rejects.toThrow(NotFoundException);

    expect(db.update).not.toHaveBeenCalled();
  });

  it("deleteChangeRequest rejects a cross-project request with NotFoundException", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn(),
      update: jest.fn(),
      transaction: jest.fn(),
    };
    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    await expect(svc.deleteChangeRequest(makeU("org-attacker"), 1, 1)).rejects.toThrow(
      NotFoundException,
    );

    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("ChangeRequestsService — duplicate decision does not overwrite decidedAt", () => {
  it("a second approve call when already approved does not set a new decidedAt", async () => {
    const existingRow = {
      id: 1,
      status: "approved",
      requestedById: "user-1",
    };
    const updatedRow = { ...existingRow, title: "T", orgId: "org-1" };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([existingRow]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updatedRow]),
          }),
        }),
      }),
      transaction: jest.fn(),
    };
    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    await svc.updateChangeRequest(makeU("org-1", true), 1, 1, { status: "approved" });

    const setCall = (db.update().set as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall).not.toHaveProperty("decidedAt");
  });

  it("a second reject call when already rejected does not set a new decidedAt", async () => {
    const existingRow = {
      id: 1,
      status: "rejected",
      requestedById: "user-1",
    };
    const updatedRow = { ...existingRow, title: "T", orgId: "org-1" };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([existingRow]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updatedRow]),
          }),
        }),
      }),
      transaction: jest.fn(),
    };
    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    await svc.updateChangeRequest(makeU("org-1", true), 1, 1, { status: "rejected" });

    const setCall = (db.update().set as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall).not.toHaveProperty("decidedAt");
  });
});

describe("listCrQuerySchema — opaque cursor and limit", () => {
  it("accepts an empty query (no cursor)", () => {
    expect(() => listCrQuerySchema.parse({})).not.toThrow();
  });

  it("accepts an opaque cursor string so pagination survives a round-trip", () => {
    expect(() => listCrQuerySchema.parse({ cursor: "dGVzdA" })).not.toThrow();
  });

  it("accepts a limit within the allowed range", () => {
    expect(() => listCrQuerySchema.parse({ limit: "25" })).not.toThrow();
  });

  it("rejects a limit above 100 so the server cannot be asked for unbounded pages", () => {
    expect(() => listCrQuerySchema.parse({ limit: "101" })).toThrow();
  });

  it("rejects afterCreatedAt — legacy cursor field removed in favour of opaque cursor", () => {
    expect(() =>
      listCrQuerySchema.parse({ afterCreatedAt: "2024-06-01T00:00:00.000Z" }),
    ).toThrow();
  });

  it("rejects afterId — legacy cursor field removed in favour of opaque cursor", () => {
    expect(() => listCrQuerySchema.parse({ afterId: "42" })).toThrow();
  });
});

describe("listCrQuerySchema — new filter fields", () => {
  it("accepts requesterId so the list can be filtered by who raised the CR", () => {
    expect(() => listCrQuerySchema.parse({ requesterId: "user-abc" })).not.toThrow();
  });

  it("accepts approverId so the list can be filtered by the approver", () => {
    expect(() => listCrQuerySchema.parse({ approverId: "user-xyz" })).not.toThrow();
  });

  it("accepts q for server-side text search over title", () => {
    expect(() => listCrQuerySchema.parse({ q: "foundation" })).not.toThrow();
  });

  it("rejects q longer than 200 characters to cap the search predicate size", () => {
    expect(() => listCrQuerySchema.parse({ q: "a".repeat(201) })).toThrow();
  });

  it("accepts releaseId as a positive integer to scope the list to a project release", () => {
    expect(() => listCrQuerySchema.parse({ releaseId: "7" })).not.toThrow();
    const result = listCrQuerySchema.parse({ releaseId: "7" });
    expect(result.releaseId).toBe(7);
  });

  it("rejects releaseId of zero because release ids are always positive", () => {
    expect(() => listCrQuerySchema.parse({ releaseId: "0" })).toThrow();
  });

  it("accepts clientVisible=true to return only client-facing change requests", () => {
    const result = listCrQuerySchema.parse({ clientVisible: "true" });
    expect(result.clientVisible).toBe(true);
  });

  it("accepts clientVisible=false to return only non-client-facing change requests", () => {
    const result = listCrQuerySchema.parse({ clientVisible: "false" });
    expect(result.clientVisible).toBe(false);
  });

  it("rejects an unknown query key so no undeclared filter silently poisons the query", () => {
    expect(() => listCrQuerySchema.parse({ undeclaredFilter: "x" })).toThrow();
  });
});

describe("ChangeRequestsService — listChangeRequests returns cursor page envelope", () => {
  const ORG = "org-1";
  const u = makeU(ORG);

  function makeMemberDbForPage(): Db {
    const postGateChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
      },
      select: jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([{ role: "MEMBER" }]),
              }),
            }),
          }),
        })
        .mockReturnValue(postGateChain),
    } as unknown as Db;
  }

  const gateAccess = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;

  beforeEach(() => {
    (gateAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
  });

  it("returns a cursor page object rather than a flat array", async () => {
    const db = makeMemberDbForPage();
    const svc = new ChangeRequestsService(db, gateAccess, mockAudit);
    const result = await svc.listChangeRequests(u, 1, {});
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("pagination");
    expect(result.pagination).toHaveProperty("hasMore");
    expect(result.pagination).toHaveProperty("nextCursor");
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("sets hasMore false and nextCursor null when the result set is empty", async () => {
    const db = makeMemberDbForPage();
    const svc = new ChangeRequestsService(db, gateAccess, mockAudit);
    const result = await svc.listChangeRequests(u, 1, {});
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
  });
});

describe("ChangeRequestsService — releaseId and clientVisible filters", () => {
  const ORG = "org-1";
  const u = makeU(ORG);
  const gateAccess = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;

  function makeWhereCapturingDb() {
    let capturedWhere: unknown = null;
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
      },
      select: jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([{ role: "MEMBER" }]),
              }),
            }),
          }),
        })
        .mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((condition: unknown) => {
              capturedWhere = condition;
              return {
                orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
              };
            }),
          }),
        }),
      getWhere: () => capturedWhere,
    };
    return db as unknown as Db & { getWhere: () => unknown };
  }

  beforeEach(() => {
    (gateAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
  });

  it("resolves successfully when releaseId filter is provided so the query does not blow up before hitting the DB", async () => {
    const db = makeWhereCapturingDb();
    const svc = new ChangeRequestsService(db, gateAccess, mockAudit);
    const result = await svc.listChangeRequests(u, 1, { releaseId: 42 });
    expect(result).toHaveProperty("data");
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("resolves successfully when clientVisible=true filter is provided so the portal can request client-visible CRs", async () => {
    const db = makeWhereCapturingDb();
    const svc = new ChangeRequestsService(db, gateAccess, mockAudit);
    const result = await svc.listChangeRequests(u, 1, { clientVisible: true });
    expect(result).toHaveProperty("data");
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("resolves successfully when clientVisible=false filter is provided so internal users can see unpublished CRs", async () => {
    const db = makeWhereCapturingDb();
    const svc = new ChangeRequestsService(db, gateAccess, mockAudit);
    const result = await svc.listChangeRequests(u, 1, { clientVisible: false });
    expect(result).toHaveProperty("data");
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("resolves successfully when releaseId and clientVisible are combined so scoped queries don't break", async () => {
    const db = makeWhereCapturingDb();
    const svc = new ChangeRequestsService(db, gateAccess, mockAudit);
    const result = await svc.listChangeRequests(u, 1, { releaseId: 5, clientVisible: true });
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("pagination");
  });
});
