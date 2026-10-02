import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChangeRequestsService } from "./change-requests.service";
import { listCrQuerySchema } from "./dto/change-requests.schemas";
import {
  changeRequestDetailSchema,
  changeRequestListPageSchema,
} from "./dto/change-requests-response.schemas";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import {
  MEMBER_STANDING,
  projectAccessRow,
  type ProjectAccessRow,
} from "../__tests__/project-access-doubles";

function projectGateSelect(rows: ProjectAccessRow[], rest: jest.Mock = jest.fn()): jest.Mock {
  return jest.fn((fields?: Record<string, unknown>) =>
    fields !== undefined && "manages" in fields
      ? { from: () => ({ where: () => ({ limit: async () => rows }) }) }
      : rest(fields),
  );
}


const memberScopeAccess = {
  scopeFor: async (actor: CurrentUserContext, key: string) =>
    actor.isOrgOwner ? "all" : (MEMBER_STANDING[key] ?? "none"),
} as unknown as AccessService;

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
      changeRequests: { findFirst: jest.fn().mockResolvedValue(changeRequestRow) },
    },
    select: projectGateSelect([]),
    transaction: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  };
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;
const mockAccess = memberScopeAccess;

beforeEach(() => {
  jest.resetAllMocks();
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
      select: projectGateSelect([projectAccessRow()], jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([crRow]),
          }),
        }),
      })),
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
        changeRequests: { findFirst: jest.fn() },
      },
      select: projectGateSelect([]),
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
  const gateAccess = memberScopeAccess;

  function makeNonMemberDb() {
    return {
      transaction: jest.fn(),
      select: projectGateSelect([projectAccessRow()]),
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
      select: projectGateSelect(
        [projectAccessRow({ memberRole: "MEMBER" })],
        jest.fn().mockReturnValue(postGateChain),
      ),
    } as unknown as Db;
  }

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
      select: projectGateSelect([projectAccessRow()], jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([existingRow]),
          }),
        }),
      })),
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
      select: projectGateSelect([projectAccessRow()], jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([existingRow]),
          }),
        }),
      })),
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
      select: projectGateSelect([projectAccessRow()], jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([existingRow]),
          }),
        }),
      })),
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
      select: projectGateSelect([projectAccessRow()], jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      })),
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
      select: projectGateSelect([projectAccessRow()], jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      })),
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
      select: projectGateSelect([]),
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
      select: projectGateSelect([]),
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
      select: projectGateSelect([projectAccessRow()], jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([existingRow]),
          }),
        }),
      })),
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
      select: projectGateSelect([projectAccessRow()], jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([existingRow]),
          }),
        }),
      })),
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

  it("accepts affectedTicketId so a work item's change requests can be filtered", () => {
    const result = listCrQuerySchema.parse({ affectedTicketId: "77" });
    expect(result.affectedTicketId).toBe(77);
  });

  it("rejects affectedTicketId of zero because ticket ids are always positive", () => {
    expect(() => listCrQuerySchema.parse({ affectedTicketId: "0" })).toThrow();
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

describe("change request affected-work response contracts", () => {
  const responseRow = {
    affectedItemCount: 2,
    id: 1,
    orgId: "org-1",
    projectId: 10,
    crNumber: 4,
    title: "Expand the portal",
    description: null,
    impact: null,
    estimateMinutes: null,
    budgetImpactCents: null,
    timelineImpactDays: null,
    status: "submitted",
    requestedById: null,
    approvalOwnerId: null,
    approvalOwnerMembershipId: null,
    decisionComment: null,
    decidedAt: null,
    releaseId: null,
    clientVisible: false,
    createdBy: null,
    createdAt: new Date("2026-09-23T00:00:00.000Z"),
    updatedAt: new Date("2026-09-23T00:00:00.000Z"),
    deletedAt: null,
  };

  it("requires the affected item count on a change request detail", () => {
    expect(changeRequestDetailSchema.parse(responseRow).affectedItemCount).toBe(2);
  });

  it("requires the affected item count on every change request list row", () => {
    const page = changeRequestListPageSchema.parse({
      data: [responseRow],
      pagination: { limit: 25, hasMore: false, nextCursor: null },
    });
    expect(page.data[0]?.affectedItemCount).toBe(2);
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
      select: projectGateSelect(
        [projectAccessRow({ memberRole: "MEMBER" })],
        jest.fn().mockReturnValue(postGateChain),
      ),
    } as unknown as Db;
  }

  const gateAccess = memberScopeAccess;

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
  const gateAccess = memberScopeAccess;

  function makeWhereCapturingDb() {
    let capturedWhere: unknown = null;
    const db = {
      select: projectGateSelect([projectAccessRow({ memberRole: "MEMBER" })], jest
        .fn()
        .mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((condition: unknown) => {
              capturedWhere = condition;
              return {
                orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
              };
            }),
          }),
        })),
      getWhere: () => capturedWhere,
    };
    return db as unknown as Db & { getWhere: () => unknown };
  }

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

  it("resolves successfully when affectedTicketId scopes the list to linked work", async () => {
    const db = makeWhereCapturingDb();
    const svc = new ChangeRequestsService(db, gateAccess, mockAudit);
    const result = await svc.listChangeRequests(u, 1, { affectedTicketId: 77 });
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("pagination");
  });
});
