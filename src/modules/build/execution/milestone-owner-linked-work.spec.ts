import { BadRequestException } from "@nestjs/common";
import { milestoneRowSchema } from "./dto/workspace-response.schemas";
import { listMilestonesQuerySchema } from "./dto/workspace.schemas";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { MilestonesService } from "./workspace.service";
import { lifecycleAuditDouble } from "../lifecycle/audit-double";
import { assertProjectAccess, assertProjectWriteAccess } from "../core/project-crud/project-access";

jest.mock("../core/project-crud/project-access", () => ({
  ...jest.requireActual("../core/project-crud/project-access"),
  assertProjectAccess: jest.fn().mockResolvedValue(undefined),
  assertProjectWriteAccess: jest.fn().mockResolvedValue(undefined),
}));

const ORG = "org-1";
const PROJECT_ID = 1;

function makeU(isOrgOwner = true): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, isOrgOwner),
  };
}

const mockAccess = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
} as unknown as AccessService;

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

function milestoneChain(rows: unknown[]) {
  const c: Record<string, jest.Mock> = {};
  const self = () => c;
  c.from = jest.fn(self);
  c.leftJoin = jest.fn(self);
  c.orderBy = jest.fn(self);
  c.where = jest.fn(self);
  c.groupBy = jest.fn(() => Promise.resolve([]));
  c.limit = jest.fn(() => Promise.resolve(rows));
  return c;
}

function countChain(counts: unknown[]) {
  const c: Record<string, jest.Mock> = {};
  const self = () => c;
  c.from = jest.fn(self);
  c.leftJoin = jest.fn(self);
  c.where = jest.fn(self);
  c.groupBy = jest.fn(() => Promise.resolve(counts));
  return c;
}

const VALID_DATE = new Date("2026-01-01T00:00:00Z");

const VALID_MILESTONE_ROW = {
  id: 1,
  projectId: 1,
  orgId: ORG,
  name: "M1",
  description: null,
  targetDate: "2026-01-01",
  status: "PENDING",
  createdBy: "user-1",
  ownerMembershipId: null,
  owner: null,
  linkedTicketCount: 0,
  completedTicketCount: 0,
  clientVisible: true,
  version: 1,
  deletedAt: null,
  createdAt: VALID_DATE,
  updatedAt: VALID_DATE,
};

describe("milestoneRowSchema — new required fields are enforced so the contract cannot drift silently", () => {
  it("accepts a fully populated row with owner null and linkedTicketCount zero", () => {
    expect(milestoneRowSchema.safeParse(VALID_MILESTONE_ROW).success).toBe(true);
  });

  it("rejects a row missing the owner key even when ownerMembershipId is null — nullable is not optional", () => {
    const { owner: _removed, ...row } = VALID_MILESTONE_ROW;
    expect(milestoneRowSchema.safeParse(row).success).toBe(false);
  });

  it("rejects a row missing linkedTicketCount because the count is required for every milestone", () => {
    const { linkedTicketCount: _removed, ...row } = VALID_MILESTONE_ROW;
    expect(milestoneRowSchema.safeParse(row).success).toBe(false);
  });

  it("rejects a row missing completedTicketCount because progress cannot be rendered without it", () => {
    const { completedTicketCount: _removed, ...row } = VALID_MILESTONE_ROW;
    expect(milestoneRowSchema.safeParse(row).success).toBe(false);
  });

  it("rejects a row missing ownerMembershipId because nullable is not optional", () => {
    const { ownerMembershipId: _removed, ...row } = VALID_MILESTONE_ROW;
    expect(milestoneRowSchema.safeParse(row).success).toBe(false);
  });
});

describe("MilestonesService — ownerId filter narrows the WHERE predicate", () => {
  it("ownerId=5 is present in the WHERE condition so non-matching milestones are filtered server-side", async () => {
    const whereSpy = jest.fn();
    const c: Record<string, jest.Mock> = {};
    const self = () => c;
    c.from = jest.fn(self);
    c.leftJoin = jest.fn(self);
    c.orderBy = jest.fn(self);
    c.where = jest.fn((cond: unknown) => { whereSpy(cond); return c; });
    c.groupBy = jest.fn(() => Promise.resolve([]));
    c.limit = jest.fn(() => Promise.resolve([]));

    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) } },
      select: jest.fn().mockReturnValue(c),
    } as unknown as Db;

    const query = listMilestonesQuerySchema.parse({ ownerId: "5" });
    await new MilestonesService(db, mockAccess, lifecycleAuditDouble()).listMilestones(makeU(), PROJECT_ID, query);

    expect(whereSpy).toHaveBeenCalled();
    const condition = whereSpy.mock.calls[0]?.[0];
    expect(sqlValues(condition)).toContain(5);
  });

  it("listMilestonesQuerySchema accepts ownerId as a numeric string and coerces it — deep-link no longer 400s", () => {
    const result = listMilestonesQuerySchema.safeParse({ ownerId: "42" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ownerId).toBe(42);
  });
});

describe("MilestonesService — createMilestone owner cross-tenant isolation", () => {
  function makeDb(memberRow: unknown, milestoneRow: unknown) {
    const orgMemberFindFirst = jest.fn().mockResolvedValue(memberRow);
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        organizationMembers: { findFirst: orgMemberFindFirst },
      },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([milestoneRow]),
        }),
      }),
    } as unknown as Db;
    return { db, orgMemberFindFirst };
  }

  const STUB_MILESTONE = {
    id: 10, projectId: PROJECT_ID, orgId: ORG, name: "New", description: null,
    targetDate: "2026-06-01", status: "PENDING", createdBy: "user-1",
    ownerMembershipId: 7, clientVisible: false, version: 1,
    deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
  };

  it("createMilestone rejects an ownerMembershipId from another org with BadRequestException so cross-tenant IDs never reach the INSERT", async () => {
    const { db } = makeDb(undefined, null);
    const svc = new MilestonesService(db, mockAccess, lifecycleAuditDouble());
    await expect(
      svc.createMilestone(makeU(), PROJECT_ID, { name: "M", targetDate: "2026-06-01", status: "PENDING", ownerMembershipId: 99 }),
    ).rejects.toThrow(BadRequestException);
  });

  it("createMilestone succeeds when ownerMembershipId belongs to the actor org and returns owner stub", async () => {
    const { db } = makeDb({ id: 7 }, STUB_MILESTONE);
    const svc = new MilestonesService(db, mockAccess, lifecycleAuditDouble());
    const result = await svc.createMilestone(makeU(), PROJECT_ID, { name: "M", targetDate: "2026-06-01", status: "PENDING", ownerMembershipId: 7 });
    expect(result.ownerMembershipId).toBe(7);
    expect(result.owner).not.toBeNull();
    expect(result.linkedTicketCount).toBe(0);
  });

  it("createMilestone with no ownerMembershipId skips the org check and returns owner null", async () => {
    const { db, orgMemberFindFirst } = makeDb(undefined, { ...STUB_MILESTONE, ownerMembershipId: null });
    const svc = new MilestonesService(db, mockAccess, lifecycleAuditDouble());
    const result = await svc.createMilestone(makeU(), PROJECT_ID, { name: "M", targetDate: "2026-06-01", status: "PENDING" });
    expect(result.owner).toBeNull();
    expect(result.linkedTicketCount).toBe(0);
    expect(orgMemberFindFirst).not.toHaveBeenCalled();
  });
});

describe("MilestonesService — linked ticket count uses one aggregate query regardless of milestone count (BE-47)", () => {
  function makeListDb(milestoneRows: unknown[], ticketCounts: unknown[]) {
    const selectSpy = jest.fn()
      .mockReturnValueOnce(milestoneChain(milestoneRows))
      .mockReturnValueOnce(countChain(ticketCounts));
    return {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) } },
      select: selectSpy,
    } as unknown as Db;
  }

  const M1 = { id: 1, orgId: ORG, name: "M1", targetDate: "2026-01-01" };
  const M2 = { id: 2, orgId: ORG, name: "M2", targetDate: "2026-02-01" };
  const M3 = { id: 3, orgId: ORG, name: "M3", targetDate: "2026-03-01" };

  it("db.select is called exactly twice for a 3-milestone page — one milestone query and one batch count, never N counts", async () => {
    const db = makeListDb([M1, M2, M3], []);
    const selectSpy = db.select as jest.Mock;
    await new MilestonesService(db, mockAccess, lifecycleAuditDouble()).listMilestones(makeU(), PROJECT_ID, listMilestonesQuerySchema.parse({}));
    expect(selectSpy).toHaveBeenCalledTimes(2);
  });

  it("db.select is called exactly twice for a 1-milestone page confirming the count does not grow with milestone count", async () => {
    const db = makeListDb([M1], []);
    const selectSpy = db.select as jest.Mock;
    await new MilestonesService(db, mockAccess, lifecycleAuditDouble()).listMilestones(makeU(), PROJECT_ID, listMilestonesQuerySchema.parse({}));
    expect(selectSpy).toHaveBeenCalledTimes(2);
  });

  it("db.select is called exactly once for an empty page because the ticket count query is skipped", async () => {
    const db = makeListDb([], []);
    const selectSpy = db.select as jest.Mock;
    await new MilestonesService(db, mockAccess, lifecycleAuditDouble()).listMilestones(makeU(), PROJECT_ID, listMilestonesQuerySchema.parse({}));
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it("milestone with four linked tickets gets linkedTicketCount four and milestone with no tickets gets zero", async () => {
    const db = makeListDb([M1, M2], [{ milestoneId: 1, linked: 4, completed: 1 }]);
    const result = await new MilestonesService(db, mockAccess, lifecycleAuditDouble()).listMilestones(makeU(), PROJECT_ID, listMilestonesQuerySchema.parse({}));
    const row1 = result.data.find((r) => r.id === 1);
    const row2 = result.data.find((r) => r.id === 2);
    expect(row1?.linkedTicketCount).toBe(4);
    expect(row2?.linkedTicketCount).toBe(0);
  });

  it("completedTicketCount comes from the same aggregate row so progress needs no extra query", async () => {
    const db = makeListDb([M1, M2], [{ milestoneId: 1, linked: 4, completed: 3 }]);
    const selectSpy = db.select as jest.Mock;
    const result = await new MilestonesService(db, mockAccess, lifecycleAuditDouble()).listMilestones(makeU(), PROJECT_ID, listMilestonesQuerySchema.parse({}));
    expect(result.data.find((r) => r.id === 1)?.completedTicketCount).toBe(3);
    expect(result.data.find((r) => r.id === 2)?.completedTicketCount).toBe(0);
    expect(selectSpy).toHaveBeenCalledTimes(2);
  });

  it("the completed aggregate is filtered by the project status type, not by a hardcoded status name", async () => {
    const db = makeListDb([M1], []);
    await new MilestonesService(db, mockAccess, lifecycleAuditDouble()).listMilestones(makeU(), PROJECT_ID, listMilestonesQuerySchema.parse({}));
    const countSelect = (db.select as jest.Mock).mock.calls[1]?.[0] as Record<string, unknown>;
    expect(sqlValues(countSelect.completed).join("")).toMatch(/FILTER \(WHERE .* = 'completed'\)/);
  });

  it("owner is populated from joined user columns when ownerMembershipId is set", async () => {
    const milestoneWithOwner = { id: 5, orgId: ORG, name: "M5", targetDate: "2026-05-01", ownerMembershipId: 7, ownerFirstName: "Alice", ownerLastName: "Smith", ownerImage: null };
    const db = makeListDb([milestoneWithOwner], []);
    const result = await new MilestonesService(db, mockAccess, lifecycleAuditDouble()).listMilestones(makeU(), PROJECT_ID, listMilestonesQuerySchema.parse({}));
    const row = result.data[0];
    expect(row?.owner).toEqual({ membershipId: 7, firstName: "Alice", lastName: "Smith", image: null });
  });

  it("owner is null when ownerMembershipId is null so no phantom owner object leaks to the client", async () => {
    const milestoneNoOwner = { id: 6, orgId: ORG, name: "M6", targetDate: "2026-06-01", ownerMembershipId: null };
    const db = makeListDb([milestoneNoOwner], []);
    const result = await new MilestonesService(db, mockAccess, lifecycleAuditDouble()).listMilestones(makeU(), PROJECT_ID, listMilestonesQuerySchema.parse({}));
    expect(result.data[0]?.owner).toBeNull();
  });
});

describe("MilestonesService — updateMilestone projects the real counts, so a cache patch cannot zero a milestone's linked work", () => {
  function makeUpdateDb(counts: unknown[]) {
    const countChainWithJoin: Record<string, jest.Mock> = {};
    const self = () => countChainWithJoin;
    countChainWithJoin.from = jest.fn(self);
    countChainWithJoin.leftJoin = jest.fn(self);
    countChainWithJoin.where = jest.fn(self);
    countChainWithJoin.groupBy = jest.fn(() => Promise.resolve(counts));
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
        projectMilestones: { findFirst: jest.fn().mockResolvedValue({ version: 1, ownerMembershipId: null }) },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1, orgId: ORG, projectId: PROJECT_ID, name: "M1", version: 2, ownerMembershipId: null }]),
          }),
        }),
      }),
      select: jest.fn().mockReturnValue(countChainWithJoin),
    } as unknown as Db;
  }

  it("returns the milestone's four linked and three completed tickets instead of the zero the previous projection hardcoded", async () => {
    const db = makeUpdateDb([{ milestoneId: 1, linked: 4, completed: 3 }]);
    const result = await new MilestonesService(db, mockAccess, lifecycleAuditDouble()).updateMilestone(makeU(), PROJECT_ID, 1, { version: 1, name: "M1" });
    expect(result.linkedTicketCount).toBe(4);
    expect(result.completedTicketCount).toBe(3);
  });

  it("returns zero counts for a milestone the aggregate returned no row for", async () => {
    const db = makeUpdateDb([]);
    const result = await new MilestonesService(db, mockAccess, lifecycleAuditDouble()).updateMilestone(makeU(), PROJECT_ID, 1, { version: 1, name: "M1" });
    expect(result.linkedTicketCount).toBe(0);
    expect(result.completedTicketCount).toBe(0);
  });
});

describe("MilestonesService — every milestone surface asks the project-access decision for the URL project", () => {
  it("listMilestones reads through assertProjectAccess and updateMilestone writes through assertProjectWriteAccess", async () => {
    const reads = jest.mocked(assertProjectAccess);
    const writes = jest.mocked(assertProjectWriteAccess);
    reads.mockClear();
    writes.mockClear();
    const c = milestoneChain([]);
    const db = {
      query: { projectMilestones: { findFirst: jest.fn().mockResolvedValue(undefined) } },
      select: jest.fn().mockReturnValue(c),
    } as unknown as Db;
    const svc = new MilestonesService(db, mockAccess, lifecycleAuditDouble());
    await svc.listMilestones(makeU(), PROJECT_ID, listMilestonesQuerySchema.parse({}));
    expect(reads).toHaveBeenCalledWith(db, mockAccess, makeU(), PROJECT_ID);
    await svc.updateMilestone(makeU(), PROJECT_ID, 1, { version: 1, name: "M1" }).catch(() => undefined);
    expect(writes).toHaveBeenCalledWith(db, mockAccess, makeU(), PROJECT_ID);
  });
});
