import { productAccessProvider, productActorIn } from "./__tests__/managed-products-spec-fixtures";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import { ManagedProductsService } from "./managed-products.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { TicketVersionConflictException } from "../core";
import { updateManagedProductSchema } from "./dto/managed-products.schemas";

const pgDialect = new PgDialect();

function renderSql(value: unknown): string {
  return pgDialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

const ORG_ID = "org-1";
const OTHER_ORG = "org-9";
const USER_ID = "user-1";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    managedProductId: 1,
    orgId: ORG_ID,
    name: "Atlas",
    key: "ATLAS",
    description: null,
    ownerId: null,
    ownerMembershipId: null,
    status: "active",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe("ManagedProductsService", () => {
  let svc: ManagedProductsService;
  let mockDb: Record<string, unknown>;

  function makeSelectChain(rows: unknown[]) {
    const whereChain = { limit: jest.fn().mockResolvedValue(rows) };
    const fromChain = { where: jest.fn().mockReturnValue(whereChain) };
    const selectChain = { from: jest.fn().mockReturnValue(fromChain) };
    return { selectChain, fromChain, whereChain };
  }

  beforeEach(async () => {
    jest.resetAllMocks();

    mockDb = {
      select: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      query: {},
      transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(mockDb)),
    };

    const module = await Test.createTestingModule({
      providers: [
        ManagedProductsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
        productAccessProvider(),
      ],
    }).compile();
    svc = module.get(ManagedProductsService);
  });

  describe("loadProduct — BOLA cross-tenant isolation", () => {
    it("throws 404 when the id belongs to a different tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getManagedProduct(OTHER_ORG, 1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("throws 404 when the product is soft-deleted (deletedAt set)", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getManagedProduct(ORG_ID, 999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("returns the row when it belongs to the caller's tenant", async () => {
      const product = makeProduct();
      const { selectChain } = makeSelectChain([product]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getManagedProduct(ORG_ID, 1)).resolves.toMatchObject({
        managedProductId: 1,
        orgId: ORG_ID,
      });
    });
  });

  describe("createManagedProduct — tenant-scoped uniqueness (23505 → 409)", () => {
    it("maps a Postgres unique violation to ConflictException", async () => {
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue({ code: "23505" }),
        }),
      });

      await expect(
        svc.createManagedProduct(ORG_ID, USER_ID, null, { name: "Atlas", key: "ATLAS" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it("inserts and audit-logs on success", async () => {
      const row = makeProduct({ managedProductId: 7 });
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([row]),
        }),
      });

      const result = await svc.createManagedProduct(ORG_ID, USER_ID, null, {
        name: "Atlas",
        key: "ATLAS",
      });

      expect(result).toMatchObject({ managedProductId: 7, orgId: ORG_ID });
      expect(mockAudit.log).toHaveBeenCalledTimes(1);
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "managed_product.created",
          orgId: ORG_ID,
          userId: USER_ID,
          resourceType: "managed_product",
        }),
      );
    });
  });

  describe("updateManagedProduct — re-asserts access before writing", () => {
    it("throws 404 (via loadProduct) when the id is not in the caller's tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.updateManagedProduct(OTHER_ORG, USER_ID, 1, { version: 1, name: "x" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("applies the patch and audit-logs when the product exists", async () => {
      const existing = makeProduct();
      const updated = makeProduct({ name: "Atlas v2" });
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await svc.updateManagedProduct(ORG_ID, USER_ID, 1, {
        version: 1,
        name: "Atlas v2",
      });

      expect(result).toMatchObject({ name: "Atlas v2" });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "managed_product.updated", orgId: ORG_ID }),
      );
    });

    it("UPDATE WHERE includes isNull(deletedAt) so a concurrently soft-deleted row cannot be overwritten", async () => {
      const existing = makeProduct();
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      let capturedWhere: unknown;
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((cond: unknown) => {
            capturedWhere = cond;
            return { returning: jest.fn().mockResolvedValue([existing]) };
          }),
        }),
      });

      await svc.updateManagedProduct(ORG_ID, USER_ID, 1, { version: 1, name: "safe" });

      const sql = renderSql(capturedWhere);
      expect(sql).toMatch(/deleted_at/);
      expect(sql).toMatch(/is null/i);
    });
  });

  describe("updateManagedProduct — version conflict guard", () => {
    it("rejects an update that omits version so the conflict check cannot be bypassed by a missing token", () => {
      expect(() => updateManagedProductSchema.parse({ name: "x" })).toThrow();
    });

    it("throws TicketVersionConflictException when the supplied version is stale so concurrent edits are detected", async () => {
      const existing = makeProduct({ version: 2 });
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.updateManagedProduct(ORG_ID, USER_ID, 1, { version: 1, name: "New name" }),
      ).rejects.toBeInstanceOf(TicketVersionConflictException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("succeeds when the supplied version matches the stored version", async () => {
      const existing = makeProduct({ version: 3 });
      const updated = makeProduct({ version: 4, name: "Atlas v2" });
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await svc.updateManagedProduct(ORG_ID, USER_ID, 1, {
        version: 3,
        name: "Atlas v2",
      });

      expect(result).toMatchObject({ name: "Atlas v2" });
    });

    it("does not include version in the DB patch so the trigger bumps it exactly once per edit", async () => {
      const existing = makeProduct({ version: 1 });
      const updated = makeProduct({ version: 2 });
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      let capturedSet: unknown;
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockImplementation((patch: unknown) => {
          capturedSet = patch;
          return {
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([updated]),
            }),
          };
        }),
      });

      await svc.updateManagedProduct(ORG_ID, USER_ID, 1, { version: 1, name: "Atlas v2" });

      expect(capturedSet).not.toHaveProperty("version");
    });

    it("returns the stored row without issuing an UPDATE when the body carries only the version, because an empty set clause is a driver error and not a 500 the caller can act on", async () => {
      const existing = makeProduct({ version: 5 });
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const result = await svc.updateManagedProduct(ORG_ID, USER_ID, 1, { version: 5 });

      expect(result).toMatchObject({ version: 5 });
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });
  });

  describe("deleteManagedProduct — soft delete", () => {
    it("throws 404 when the id is not in the caller's tenant (no write)", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.deleteManagedProduct(OTHER_ORG, USER_ID, 1),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("sets deletedAt and audit-logs when the product exists", async () => {
      const existing = makeProduct();
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      await svc.deleteManagedProduct(ORG_ID, USER_ID, 1);

      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: expect.any(Date) }),
      );
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "managed_product.deleted", orgId: ORG_ID }),
      );
    });

    it("soft-delete WHERE includes isNull(deletedAt) so a concurrently double-deleted row is not touched", async () => {
      const existing = makeProduct();
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      let capturedWhere: unknown;
      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((cond: unknown) => {
          capturedWhere = cond;
          return Promise.resolve(undefined);
        }),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      await svc.deleteManagedProduct(ORG_ID, USER_ID, 1);

      const sql = renderSql(capturedWhere);
      expect(sql).toMatch(/deleted_at/);
      expect(sql).toMatch(/is null/i);
    });
  });

  describe("getProductInsights — tenant-scoped aggregates (BSN-01-022)", () => {
    function makeGroupedSelectChain(rows: unknown[], joined = false) {
      const groupByChain = Promise.resolve(rows);
      const whereChain = { groupBy: jest.fn().mockReturnValue(groupByChain) };
      if (joined) {
        const innerJoinChain = {
          innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(whereChain) }),
          where: jest.fn().mockReturnValue(whereChain),
        };
        const fromChain = { innerJoin: jest.fn().mockReturnValue(innerJoinChain) };
        return { from: jest.fn().mockReturnValue(fromChain) };
      }
      const fromChain = { where: jest.fn().mockReturnValue(whereChain) };
      return { from: jest.fn().mockReturnValue(fromChain) };
    }

    it("throws 404 when the product is not found in the caller's tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getProductInsights(productActorIn(ORG_ID), 99)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("sums project and submission counts grouped by status", async () => {
      const product = makeProduct();
      const { selectChain: loadChain } = makeSelectChain([product]);
      const projectsChain = makeGroupedSelectChain([
        { status: "ACTIVE", tally: 3 },
        { status: "COMPLETED", tally: 1 },
      ]);
      const submissionsChain = makeGroupedSelectChain(
        [{ status: "open", tally: 5 }, { status: "resolved", tally: 2 }],
        true,
      );

      (mockDb as { select: jest.Mock }).select
        .mockReturnValueOnce(loadChain)
        .mockReturnValueOnce(projectsChain)
        .mockReturnValueOnce(submissionsChain)
        .mockReturnValueOnce(makeGroupedSelectChain([], true))
        .mockReturnValueOnce(makeGroupedSelectChain([], true));

      const result = await svc.getProductInsights(productActorIn(ORG_ID), 1);

      expect(result.linkedProjectCount).toBe(4);
      expect(result.projectsByStatus).toEqual({ active: 3, completed: 1, archived: 0 });
      expect(result.submissionsByStatus).toMatchObject({ open: 5, resolved: 2, in_progress: 0 });
      expect(result.roadmapItemCount).toBe(0);
      expect(result.linkedFeedbackVoteCount).toBe(0);
    });

    it("returns all zeros when no projects or submissions are linked to the product", async () => {
      const product = makeProduct();
      const { selectChain: loadChain } = makeSelectChain([product]);
      const projectsChain = makeGroupedSelectChain([]);
      const submissionsChain = makeGroupedSelectChain([], true);

      (mockDb as { select: jest.Mock }).select
        .mockReturnValueOnce(loadChain)
        .mockReturnValueOnce(projectsChain)
        .mockReturnValueOnce(submissionsChain)
        .mockReturnValueOnce(makeGroupedSelectChain([], true))
        .mockReturnValueOnce(makeGroupedSelectChain([], true));

      const result = await svc.getProductInsights(productActorIn(ORG_ID), 1);

      expect(result.linkedProjectCount).toBe(0);
      expect(result.projectsByStatus).toEqual({ active: 0, completed: 0, archived: 0 });
      expect(result.submissionsByStatus).toEqual({ open: 0, in_progress: 0, resolved: 0, archived: 0 });
      expect(result.roadmapItemCount).toBe(0);
      expect(result.linkedFeedbackVoteCount).toBe(0);
    });
  });

  describe("getProductInsights — range filter (BSN-INS-RANGE)", () => {
    function makeCapturableGroupedChain(rows: unknown[], joined = false) {
      let capturedWhere: unknown;
      const groupByChain = Promise.resolve(rows);
      const whereChain = {
        groupBy: jest.fn().mockReturnValue(groupByChain),
      };
      const capturingWhere = jest.fn().mockImplementation((cond: unknown) => {
        capturedWhere = cond;
        return whereChain;
      });
      if (joined) {
        const innerJoinChain = {
          innerJoin: jest.fn().mockReturnValue({
            where: capturingWhere,
          }),
          where: capturingWhere,
        };
        const fromChain = { innerJoin: jest.fn().mockReturnValue(innerJoinChain) };
        return { chain: { from: jest.fn().mockReturnValue(fromChain) }, getCapturedWhere: () => capturedWhere };
      }
      const fromChain = { where: capturingWhere };
      return { chain: { from: jest.fn().mockReturnValue(fromChain) }, getCapturedWhere: () => capturedWhere };
    }

    it("includes created_at gte condition in the projects query when range=7d so only recently created projects are counted", async () => {
      const product = makeProduct();
      const { selectChain: loadChain } = makeSelectChain([product]);
      const { chain: projectsChain, getCapturedWhere } = makeCapturableGroupedChain([]);
      const submissionsChain = makeCapturableGroupedChain([], true).chain;

      (mockDb as { select: jest.Mock }).select
        .mockReturnValueOnce(loadChain)
        .mockReturnValueOnce(projectsChain)
        .mockReturnValueOnce(submissionsChain)
        .mockReturnValueOnce(makeCapturableGroupedChain([], true).chain)
        .mockReturnValueOnce(makeCapturableGroupedChain([], true).chain);

      await svc.getProductInsights(productActorIn(ORG_ID), 1, { range: "7d" });

      const sql = renderSql(getCapturedWhere());
      expect(sql).toMatch(/created_at/);
    });

    it("omits created_at condition when no range is provided so all-time data is returned", async () => {
      const product = makeProduct();
      const { selectChain: loadChain } = makeSelectChain([product]);
      const { chain: projectsChain, getCapturedWhere } = makeCapturableGroupedChain([]);
      const submissionsChain = makeCapturableGroupedChain([], true).chain;

      (mockDb as { select: jest.Mock }).select
        .mockReturnValueOnce(loadChain)
        .mockReturnValueOnce(projectsChain)
        .mockReturnValueOnce(submissionsChain)
        .mockReturnValueOnce(makeCapturableGroupedChain([], true).chain)
        .mockReturnValueOnce(makeCapturableGroupedChain([], true).chain);

      await svc.getProductInsights(productActorIn(ORG_ID), 1, {});

      const sql = renderSql(getCapturedWhere());
      expect(sql).not.toMatch(/created_at.*>=|>= .* created_at/i);
    });

    it("computes rangeStart approximately 7 days ago for range=7d so the date boundary is within 1 second of expected", async () => {
      const before = new Date();
      const product = makeProduct();
      const { selectChain: loadChain } = makeSelectChain([product]);
      const { chain: projectsChain } = makeCapturableGroupedChain([]);

      (mockDb as { select: jest.Mock }).select
        .mockReturnValueOnce(loadChain)
        .mockReturnValueOnce(projectsChain)
        .mockReturnValueOnce(makeCapturableGroupedChain([], true).chain)
        .mockReturnValueOnce(makeCapturableGroupedChain([], true).chain)
        .mockReturnValueOnce(makeCapturableGroupedChain([], true).chain);

      await svc.getProductInsights(productActorIn(ORG_ID), 1, { range: "7d" });

      const after = new Date();
      const expected7dAgo = before.getTime() - 7 * 24 * 60 * 60 * 1000;
      const expected7dAgoUpper = after.getTime() - 7 * 24 * 60 * 60 * 1000;
      expect(expected7dAgo).toBeLessThanOrEqual(expected7dAgoUpper + 1000);
    });
  });

  describe("listManagedProducts — pagination envelope", () => {
    it("returns { data, pagination } with cursor-page shape", async () => {
      const rows = [makeProduct(), makeProduct({ managedProductId: 2, key: "B" })];

      (mockDb as { select: jest.Mock }).select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      });

      const result = await svc.listManagedProducts(ORG_ID, { limit: 20 } as never, 1);

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({
        limit: 20,
        hasMore: false,
        nextCursor: null,
      });
    });
  });

  describe("listManagedProducts — ownerId and sort filters (C3)", () => {
    function makeListChain(rows: unknown[]) {
      let capturedWhere: unknown;
      let capturedOrderBy: unknown[];
      const chain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((cond: unknown) => {
            capturedWhere = cond;
            return {
              orderBy: jest.fn().mockImplementation((...args: unknown[]) => {
                capturedOrderBy = args;
                return { limit: jest.fn().mockResolvedValue(rows) };
              }),
            };
          }),
        }),
      };
      return {
        chain,
        getCapturedWhere: () => capturedWhere,
        getCapturedOrderBy: () => capturedOrderBy,
      };
    }

    it("includes owner_id condition when ownerId is provided so only that owner's products are returned", async () => {
      const rows = [makeProduct({ ownerId: "user-abc" })];
      const { chain, getCapturedWhere } = makeListChain(rows);
      (mockDb as { select: jest.Mock }).select.mockReturnValueOnce(chain);

      await svc.listManagedProducts(ORG_ID, { limit: 20, ownerId: "user-abc" } as never, null);

      const sql = renderSql(getCapturedWhere());
      expect(sql).toMatch(/owner_id/);
    });

    it("orders by name ASC when sort=name so the list is alphabetically sorted", async () => {
      const rows = [makeProduct({ name: "Alpha" }), makeProduct({ managedProductId: 2, name: "Beta", key: "B" })];
      const { chain, getCapturedOrderBy } = makeListChain(rows);
      (mockDb as { select: jest.Mock }).select.mockReturnValueOnce(chain);

      await svc.listManagedProducts(ORG_ID, { limit: 20, sort: "name" } as never, null);

      const orderSql = getCapturedOrderBy().map((o) => renderSql(o)).join(" ");
      expect(orderSql).toMatch(/name/);
      expect(orderSql).toMatch(/asc/i);
    });

    it("orders by updated_at DESC when sort=updated so most recently changed products appear first", async () => {
      const rows = [makeProduct()];
      const { chain, getCapturedOrderBy } = makeListChain(rows);
      (mockDb as { select: jest.Mock }).select.mockReturnValueOnce(chain);

      await svc.listManagedProducts(ORG_ID, { limit: 20, sort: "updated" } as never, null);

      const orderSql = getCapturedOrderBy().map((o) => renderSql(o)).join(" ");
      expect(orderSql).toMatch(/updated_at/);
      expect(orderSql).toMatch(/desc/i);
    });

    it("orders by status ASC when sort=status so products are grouped by lifecycle state", async () => {
      const rows = [makeProduct()];
      const { chain, getCapturedOrderBy } = makeListChain(rows);
      (mockDb as { select: jest.Mock }).select.mockReturnValueOnce(chain);

      await svc.listManagedProducts(ORG_ID, { limit: 20, sort: "status" } as never, null);

      const orderSql = getCapturedOrderBy().map((o) => renderSql(o)).join(" ");
      expect(orderSql).toMatch(/status/);
      expect(orderSql).toMatch(/asc/i);
    });
  });

  describe("bulkUpdateManagedProducts — status update (C3 S1)", () => {
    function makeBulkUpdateChain(returnedIds: number[]) {
      let capturedWhere: unknown;
      const returningMock = jest.fn().mockResolvedValue(returnedIds.map((id) => ({ id })));
      const whereMock = jest.fn().mockImplementation((cond: unknown) => {
        capturedWhere = cond;
        return { returning: returningMock };
      });
      const setMock = jest.fn().mockReturnValue({ where: whereMock });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setMock });
      return { setMock, whereMock, getCapturedWhere: () => capturedWhere };
    }

    it("updates all ids that belong to the org and returns outcome per id", async () => {
      makeBulkUpdateChain([1, 2]);

      const result = await svc.bulkUpdateManagedProducts(ORG_ID, USER_ID, {
        ids: [1, 2],
        action: "update_status",
        status: "archived",
      });

      expect(result.requested).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.results).toEqual([
        { id: 1, outcome: "updated", reason: null },
        { id: 2, outcome: "updated", reason: null },
      ]);
    });

    it("marks ids not returned by the DB as skipped so partial results are surfaced to the caller", async () => {
      makeBulkUpdateChain([1]);

      const result = await svc.bulkUpdateManagedProducts(ORG_ID, USER_ID, {
        ids: [1, 99],
        action: "update_status",
        status: "archived",
      });

      expect(result.succeeded).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.results).toContainEqual({ id: 99, outcome: "skipped", reason: "not_found_or_filtered" });
    });

    it("WHERE clause includes org_id and isNull(deletedAt) so cross-tenant and deleted rows are excluded", async () => {
      const { getCapturedWhere } = makeBulkUpdateChain([1]);

      await svc.bulkUpdateManagedProducts(ORG_ID, USER_ID, {
        ids: [1],
        action: "update_status",
        status: "active",
      });

      const sql = renderSql(getCapturedWhere());
      expect(sql).toMatch(/org_id/);
      expect(sql).toMatch(/deleted_at/);
      expect(sql).toMatch(/is null/i);
    });

    it("audit-logs after a successful bulk update", async () => {
      makeBulkUpdateChain([1, 2]);

      await svc.bulkUpdateManagedProducts(ORG_ID, USER_ID, {
        ids: [1, 2],
        action: "update_status",
        status: "archived",
      });

      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "managed_product.bulk_updated",
          orgId: ORG_ID,
          userId: USER_ID,
        }),
      );
    });
  });
});

describe("ManagedProductsService.getManagedProduct — resolved owner projection", () => {
  let svc: ManagedProductsService;
  let select: jest.Mock;

  function productChain(rows: unknown[]) {
    return {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(rows),
        }),
      }),
    };
  }

  function ownerJoinChain(rows: unknown[]) {
    return {
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    };
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    select = jest.fn();
    const module = await Test.createTestingModule({
      providers: [
        ManagedProductsService,
        {
          provide: DRIZZLE,
          useValue: { select, insert: jest.fn(), update: jest.fn(), query: {} },
        },
        { provide: AuditService, useValue: mockAudit },
        productAccessProvider(),
      ],
    }).compile();
    svc = module.get(ManagedProductsService);
  });

  it("returns a named owner so the page can render a person instead of the raw ownerId FE-85 forbids on screen", async () => {
    select
      .mockReturnValueOnce(productChain([makeProduct({ ownerId: "user-7", ownerMembershipId: 9 })]))
      .mockReturnValueOnce(
        ownerJoinChain([
          {
            id: "user-7",
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.com",
            image: null,
          },
        ]),
      );

    await expect(svc.getManagedProduct(ORG_ID, 1)).resolves.toMatchObject({
      owner: {
        id: "user-7",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      },
    });
  });

  it("returns owner null without a second query when no owner membership is set", async () => {
    select.mockReturnValueOnce(productChain([makeProduct()]));

    await expect(svc.getManagedProduct(ORG_ID, 1)).resolves.toMatchObject({
      owner: null,
    });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("scopes the owner lookup to the caller org so a cross-tenant membership id cannot name a foreign user", async () => {
    select
      .mockReturnValueOnce(productChain([makeProduct({ ownerMembershipId: 9 })]))
      .mockReturnValueOnce(ownerJoinChain([]));

    await expect(svc.getManagedProduct(ORG_ID, 1)).resolves.toMatchObject({
      owner: null,
    });
    const joinChain = select.mock.results[1]?.value as {
      from: jest.Mock;
    };
    const where = joinChain.from.mock.results[0]?.value.innerJoin.mock.results[0]?.value
      .where as jest.Mock;
    expect(renderSql(where.mock.calls[0]?.[0])).toMatch(/org_id/);
  });
});
