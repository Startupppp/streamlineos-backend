import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PartyService } from "./party.service";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const ORG_ID = "org-111";
const OTHER_ORG = "org-999";
const USER_ID = "user-abc";
const PARTY_ID = "party-uuid-1";

const mockAudit = { log: jest.fn() } as unknown as AuditService;
const mockCache = { invalidateNamespace: jest.fn() } as unknown as CacheService;

function makeParty(overrides: Record<string, unknown> = {}) {
  return {
    partyId: PARTY_ID,
    organizationId: ORG_ID,
    name: "Acme Corp",
    partyType: "CUSTOMER",
    legalName: null,
    displayName: null,
    taxNumber: null,
    email: "acme@example.com",
    phone: null,
    website: null,
    notes: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe("PartyService — party CRUD", () => {
  let svc: PartyService;
  let mockDb: Record<string, unknown>;

  function makeSelectChain(rows: unknown[], legacyIds: unknown[] = []) {
    const whereChain = Object.assign(Promise.resolve(legacyIds), {
      limit: jest.fn().mockResolvedValue(rows),
    });
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
      transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockDb)),
      query: {},
    };

    const module = await Test.createTestingModule({
      providers: [
        PartyService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile();

    svc = module.get(PartyService);
  });

  describe("getParty — BOLA cross-tenant isolation", () => {
    it("throws 404 when the party belongs to a different tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getParty(OTHER_ORG, PARTY_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("throws 404 when the party is soft-deleted (deletedAt set)", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getParty(ORG_ID, "ghost-id")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("returns the row when it belongs to the caller's tenant", async () => {
      const party = makeParty();
      const { selectChain } = makeSelectChain([party]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const result = await svc.getParty(ORG_ID, PARTY_ID);
      expect(result).toMatchObject({ partyId: PARTY_ID, organizationId: ORG_ID });
    });
  });

  describe("createParty — unique violation → 409, audit on success", () => {
    it("maps Postgres 23505 to ConflictException", async () => {
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue({ code: "23505" }),
        }),
      });

      await expect(
        svc.createParty(ORG_ID, USER_ID, { name: "Acme Corp" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it("re-throws unknown errors unchanged", async () => {
      const boom = new Error("db down");
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(boom),
        }),
      });

      await expect(
        svc.createParty(ORG_ID, USER_ID, { name: "Acme Corp" }),
      ).rejects.toThrow("db down");
    });

    it("inserts and audit-logs on success", async () => {
      const row = makeParty({ partyId: "new-party-id" });
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([row]),
          onConflictDoNothing: jest.fn().mockResolvedValue([]),
        }),
      });

      const result = await svc.createParty(ORG_ID, USER_ID, {
        name: "Acme Corp",
        partyType: "CUSTOMER",
        email: "acme@example.com",
      });

      expect(result).toMatchObject({ partyId: "new-party-id", organizationId: ORG_ID });
      expect(mockAudit.log).toHaveBeenCalledTimes(1);
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "party.party.created",
          userId: USER_ID,
          orgId: ORG_ID,
          resourceType: "business_party",
        }),
      );
    });
  });

  describe("updateParty — re-asserts access before writing", () => {
    it("throws 404 (via loadParty) when party is in a different tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.updateParty(OTHER_ORG, USER_ID, PARTY_ID, { name: "New Name" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("applies patch and audit-logs when party exists", async () => {
      const existing = makeParty();
      const updated = makeParty({ name: "Acme Updated" });

      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await svc.updateParty(ORG_ID, USER_ID, PARTY_ID, {
        name: "Acme Updated",
      });

      expect(result).toMatchObject({ name: "Acme Updated" });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "party.party.updated",
          orgId: ORG_ID,
          userId: USER_ID,
        }),
      );
    });

    it("maps 23505 to ConflictException during update", async () => {
      const existing = makeParty();
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockRejectedValue({ code: "23505" }),
          }),
        }),
      });

      await expect(
        svc.updateParty(ORG_ID, USER_ID, PARTY_ID, { name: "Clash" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.log).not.toHaveBeenCalled();
    });
  });

  describe("softDeleteParty — BOLA guard + soft-delete", () => {
    it("throws 404 when party is in a different tenant (no update)", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.softDeleteParty(OTHER_ORG, USER_ID, PARTY_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("sets deletedAt and audit-logs when party exists", async () => {
      const existing = makeParty();
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([makeParty({ deletedAt: new Date() })]),
        }),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      await svc.softDeleteParty(ORG_ID, USER_ID, PARTY_ID);

      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: expect.any(Date) }),
      );
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "party.party.deleted",
          orgId: ORG_ID,
          userId: USER_ID,
          resourceType: "business_party",
          resourceId: PARTY_ID,
        }),
      );
    });
  });

  describe("listParties — pagination envelope", () => {
    it("returns { data, pagination } with correct totalPages", async () => {
      const rows = [makeParty(), makeParty({ partyId: "party-2", name: "Beta LLC" })];

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue(rows),
                }),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ total: 2 }]),
          }),
        };
      });

      const result = await svc.listParties(ORG_ID, {
        page: 1,
        limit: 20,
      });

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
        nextCursor: null,
        hasMore: false,
      });
    });

    it("returns zero total when no parties exist", async () => {
      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue([]),
                }),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ total: 0 }]),
          }),
        };
      });

      const result = await svc.listParties(ORG_ID, { page: 1, limit: 20 });
      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
    });
  });
});
