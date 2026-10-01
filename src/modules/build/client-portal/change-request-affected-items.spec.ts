import { ConflictException, NotFoundException } from "@nestjs/common";
import { ChangeRequestAffectedItemsService } from "./change-request-affected-items.service";
import { ChangeRequestsService } from "./change-requests.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import { drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import type { AccessService } from "../../access/access.service";

jest.mock("../core/project-crud/project-access", () => ({
  ...jest.requireActual<object>("../core/project-crud/project-access"),
  assertTicketReadAccess: jest.fn().mockResolvedValue(undefined),
}));

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

const CR_ROW = {
  id: 1,
  orgId: "org-1",
  projectId: 10,
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
  releaseId: null,
  clientVisible: false,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

const TICKET_ROW = {
  id: 55,
  projectId: 10,
  title: "Fix the widget",
  ticketNumber: 3,
  status: "TODO",
  priority: "MEDIUM",
  type: "BUG",
};

function affectedItemRow(id: number, overrides: Partial<typeof TICKET_ROW> = {}) {
  return {
    id,
    orgId: "org-1",
    changeRequestId: 1,
    ticketId: TICKET_ROW.id,
    createdAt: new Date(),
    createdBy: "user-1",
    ticket: { ...TICKET_ROW, ...overrides },
  };
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;

function mockChangeRequests(behaviour: "resolve" | "reject") {
  const getChangeRequest =
    behaviour === "resolve"
      ? jest.fn().mockResolvedValue(CR_ROW)
      : jest.fn().mockRejectedValue(new NotFoundException("Change request not found"));
  return { getChangeRequest } as unknown as ChangeRequestsService;
}

function buildJoinSelectDb(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  builder.from = jest.fn().mockReturnValue(builder);
  builder.innerJoin = jest.fn().mockReturnValue(builder);
  builder.where = jest.fn().mockReturnValue(builder);
  builder.orderBy = jest.fn().mockReturnValue(builder);
  builder.limit = jest.fn().mockResolvedValue(rows);
  return {
    select: jest.fn().mockReturnValue(builder),
  } as unknown as Db;
}

function buildTicketLookupChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(rows);
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ChangeRequestAffectedItemsService — listAffectedTickets", () => {
  it("returns an empty cursor page envelope when nothing is linked", async () => {
    const db = buildJoinSelectDb([]);
    const svc = new ChangeRequestAffectedItemsService(db, mockAudit, mockChangeRequests("resolve"), stubService<AccessService>({}));

    const result = await svc.listAffectedTickets(makeU("org-1"), 10, 1, {});

    expect(result).not.toHaveProperty("items");
    expect(result).toEqual({ data: [], pagination: { limit: 25, hasMore: false, nextCursor: null } });
  });

  it("returns linked tickets with a ticket summary, keyed under data", async () => {
    const rows = [affectedItemRow(1), affectedItemRow(2, { id: 56, title: "Other ticket" })];
    const db = buildJoinSelectDb(rows);
    const svc = new ChangeRequestAffectedItemsService(db, mockAudit, mockChangeRequests("resolve"), stubService<AccessService>({}));

    const result = await svc.listAffectedTickets(makeU("org-1"), 10, 1, {});

    expect(result.data).toHaveLength(2);
    expect(result.data[0]?.ticket).toEqual(expect.objectContaining({ title: TICKET_ROW.title }));
    expect(result.pagination).toEqual({ limit: 25, hasMore: false, nextCursor: null });
  });

  it("sets hasMore and a nextCursor when a sentinel row over the limit is fetched", async () => {
    const rows = [affectedItemRow(1), affectedItemRow(2), affectedItemRow(3)];
    const db = buildJoinSelectDb(rows);
    const svc = new ChangeRequestAffectedItemsService(db, mockAudit, mockChangeRequests("resolve"), stubService<AccessService>({}));

    const result = await svc.listAffectedTickets(makeU("org-1"), 10, 1, { limit: 2 });

    expect(result.data).toHaveLength(2);
    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.nextCursor).toEqual(expect.any(String));
  });

  it("throws NotFoundException (not 403) when the change request is cross-tenant, before touching the join query", async () => {
    const db = buildJoinSelectDb([]);
    const svc = new ChangeRequestAffectedItemsService(db, mockAudit, mockChangeRequests("reject"), stubService<AccessService>({}));

    await expect(svc.listAffectedTickets(makeU("org-attacker"), 10, 1, {})).rejects.toThrow(
      NotFoundException,
    );
    expect((db.select as jest.Mock)).not.toHaveBeenCalled();
  });
});

describe("ChangeRequestAffectedItemsService — linkTicket", () => {
  it("links a ticket in the same org and project (happy path)", async () => {
    const ticketChain = buildTicketLookupChain([TICKET_ROW]);
    const insertReturning = jest.fn().mockResolvedValue([
      {
        id: 1,
        orgId: "org-1",
        changeRequestId: 1,
        ticketId: TICKET_ROW.id,
        createdAt: new Date(),
        createdBy: "user-1",
      },
    ]);
    const db = {
      select: jest.fn().mockReturnValue(ticketChain),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: insertReturning }),
      }),
    } as unknown as Db;
    const svc = new ChangeRequestAffectedItemsService(db, mockAudit, mockChangeRequests("resolve"), stubService<AccessService>({}));

    const result = await svc.linkTicket(makeU("org-1"), 10, 1, { ticketId: TICKET_ROW.id });

    expect(result.ticket.id).toBe(TICKET_ROW.id);
    expect(result.ticketId).toBe(TICKET_ROW.id);
    expect(mockAudit.log).not.toBeUndefined();
  });

  it("throws ConflictException, not a 500, on a duplicate link (23505 on the pair index)", async () => {
    const ticketChain = buildTicketLookupChain([TICKET_ROW]);
    const db = {
      select: jest.fn().mockReturnValue(ticketChain),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(
            drizzleUniqueViolation("uniq_change_request_affected_items_pair"),
          ),
        }),
      }),
    } as unknown as Db;
    const svc = new ChangeRequestAffectedItemsService(db, mockAudit, mockChangeRequests("resolve"), stubService<AccessService>({}));

    await expect(
      svc.linkTicket(makeU("org-1"), 10, 1, { ticketId: TICKET_ROW.id }),
    ).rejects.toThrow(ConflictException);
  });

  it("throws NotFoundException when the ticket does not belong to the change request's project", async () => {
    const ticketChain = buildTicketLookupChain([{ ...TICKET_ROW, projectId: 999 }]);
    const db = {
      select: jest.fn().mockReturnValue(ticketChain),
      insert: jest.fn(),
    } as unknown as Db;
    const svc = new ChangeRequestAffectedItemsService(db, mockAudit, mockChangeRequests("resolve"), stubService<AccessService>({}));

    await expect(
      svc.linkTicket(makeU("org-1"), 10, 1, { ticketId: TICKET_ROW.id }),
    ).rejects.toThrow(NotFoundException);
    expect((db.insert as jest.Mock)).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the ticket does not exist in this org (cross-tenant ticket id)", async () => {
    const ticketChain = buildTicketLookupChain([]);
    const db = {
      select: jest.fn().mockReturnValue(ticketChain),
      insert: jest.fn(),
    } as unknown as Db;
    const svc = new ChangeRequestAffectedItemsService(db, mockAudit, mockChangeRequests("resolve"), stubService<AccessService>({}));

    await expect(
      svc.linkTicket(makeU("org-1"), 10, 1, { ticketId: 9999 }),
    ).rejects.toThrow(NotFoundException);
    expect((db.insert as jest.Mock)).not.toHaveBeenCalled();
  });

  it("throws NotFoundException (not 403) when the change request itself is cross-tenant, before any ticket lookup", async () => {
    const db = { select: jest.fn(), insert: jest.fn() } as unknown as Db;
    const svc = new ChangeRequestAffectedItemsService(db, mockAudit, mockChangeRequests("reject"), stubService<AccessService>({}));

    await expect(
      svc.linkTicket(makeU("org-attacker"), 10, 1, { ticketId: TICKET_ROW.id }),
    ).rejects.toThrow(NotFoundException);
    expect((db.select as jest.Mock)).not.toHaveBeenCalled();
    expect((db.insert as jest.Mock)).not.toHaveBeenCalled();
  });
});

describe("ChangeRequestAffectedItemsService — unlinkTicket", () => {
  it("deletes the link row scoped to org and change request", async () => {
    const selectChain = buildTicketLookupChain([{ id: 5, ticketId: TICKET_ROW.id }]);
    const deleteWhere = jest.fn().mockResolvedValue(undefined);
    const db = {
      select: jest.fn().mockReturnValue(selectChain),
      delete: jest.fn().mockReturnValue({ where: deleteWhere }),
    } as unknown as Db;
    const svc = new ChangeRequestAffectedItemsService(db, mockAudit, mockChangeRequests("resolve"), stubService<AccessService>({}));

    await svc.unlinkTicket(makeU("org-1"), 10, 1, 5);

    expect((db.delete as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("throws NotFoundException when the affected item id does not belong to this change request", async () => {
    const selectChain = buildTicketLookupChain([]);
    const db = {
      select: jest.fn().mockReturnValue(selectChain),
      delete: jest.fn(),
    } as unknown as Db;
    const svc = new ChangeRequestAffectedItemsService(db, mockAudit, mockChangeRequests("resolve"), stubService<AccessService>({}));

    await expect(svc.unlinkTicket(makeU("org-1"), 10, 1, 999)).rejects.toThrow(NotFoundException);
    expect((db.delete as jest.Mock)).not.toHaveBeenCalled();
  });

  it("throws NotFoundException (not 403) when the change request is cross-tenant, before any delete", async () => {
    const db = { select: jest.fn(), delete: jest.fn() } as unknown as Db;
    const svc = new ChangeRequestAffectedItemsService(db, mockAudit, mockChangeRequests("reject"), stubService<AccessService>({}));

    await expect(svc.unlinkTicket(makeU("org-attacker"), 10, 1, 5)).rejects.toThrow(
      NotFoundException,
    );
    expect((db.select as jest.Mock)).not.toHaveBeenCalled();
    expect((db.delete as jest.Mock)).not.toHaveBeenCalled();
  });
});
