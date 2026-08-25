import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PartyService } from "./party.service";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const ORG_ID = "org-111";
const OTHER_ORG = "org-999";
const USER_ID = "user-abc";
const PARTY_ID = "party-uuid-1";
const CONTACT_ID = "contact-uuid-1";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

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

function makeContact(overrides: Record<string, unknown> = {}) {
  return {
    partyContactId: CONTACT_ID,
    organizationId: ORG_ID,
    partyId: PARTY_ID,
    firstName: "John",
    lastName: "Doe",
    email: "john@acme.com",
    phone: null,
    title: null,
    isPrimary: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe("PartyService", () => {
  let svc: PartyService;
  let mockDb: Record<string, unknown>;

  /**
   * `where` answers two shapes now, because the party writer asks two questions.
   *
   * A single-record load ends in `.limit(1)` and gets `rows`. The mirror refresh
   * awaits `.where(...)` directly to ask which legacy ids a party answers for,
   * and gets `legacyIds` -- empty by default, so a test that is not about the
   * mirror sees no mirror writes.
   */
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
      // Party writes now open a savepoint so the row and its legacy mirror commit
      // together. The callback must actually run, or every assertion inside it is
      // silently void.
      transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockDb)),
      query: {},
    };

    const module = await Test.createTestingModule({
      providers: [
        PartyService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    svc = module.get(PartyService);
  });

  // ---------------------------------------------------------------------------
  // getParty / loadParty — BOLA cross-tenant isolation
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // createParty — unique violation → ConflictException, audit on success
  // ---------------------------------------------------------------------------
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
          // The party's contact columns are claimed as identifiers in the same
          // statement stream, so `resolve-party` can find this record when the
          // customer writes in. Conflicts are ignored: a value another party
          // already holds is left with them rather than failing the save.
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

  // ---------------------------------------------------------------------------
  // updateParty — re-asserts access before writing
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // softDeleteParty — BOLA guard + audit
  // ---------------------------------------------------------------------------
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
          // The delete returns the row now: the mirror is derived from what the
          // party became, not from what the caller asked for.
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

  // ---------------------------------------------------------------------------
  // listParties — pagination envelope
  // ---------------------------------------------------------------------------
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
                // The list is ordered now: LIMIT/OFFSET without ORDER BY gives a
                // non-repeatable page, and the cursor branch needs the same order.
                orderBy: jest.fn().mockReturnValue({
                  limit: jest.fn().mockReturnValue({
                    offset: jest.fn().mockResolvedValue(rows),
                  }),
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
                  limit: jest.fn().mockReturnValue({
                    offset: jest.fn().mockResolvedValue([]),
                  }),
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

  // ---------------------------------------------------------------------------
  // listContacts — party guard
  // ---------------------------------------------------------------------------
  describe("listContacts — party guard", () => {
    it("throws 404 when the parent party is not found", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.listContacts(OTHER_ORG, PARTY_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns contacts for a valid party", async () => {
      const party = makeParty();
      const contacts = [makeContact(), makeContact({ partyContactId: "contact-2" })];

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          // loadParty chain: .from().where().limit()
          const whereChain = { limit: jest.fn().mockResolvedValue([party]) };
          const fromChain = { where: jest.fn().mockReturnValue(whereChain) };
          return { from: jest.fn().mockReturnValue(fromChain) };
        }
        // listContacts chain: .from().where() — no .limit() call
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(contacts),
          }),
        };
      });

      const result = await svc.listContacts(ORG_ID, PARTY_ID);
      expect(result).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // createContact — party guard + unique violation + audit
  // ---------------------------------------------------------------------------
  describe("createContact — party guard + unique violation", () => {
    it("throws 404 when the parent party does not exist", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.createContact(ORG_ID, USER_ID, {
          partyId: "nonexistent",
          firstName: "Jane",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
    });

    it("maps Postgres 23505 to ConflictException", async () => {
      const party = makeParty();
      const { selectChain } = makeSelectChain([party]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue({ code: "23505" }),
        }),
      });

      await expect(
        svc.createContact(ORG_ID, USER_ID, {
          partyId: PARTY_ID,
          firstName: "Jane",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it("inserts and audit-logs on success", async () => {
      const party = makeParty();
      const contact = makeContact({ partyContactId: "new-contact-id" });

      const { selectChain } = makeSelectChain([party]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([contact]),
        }),
      });

      const result = await svc.createContact(ORG_ID, USER_ID, {
        partyId: PARTY_ID,
        firstName: "Jane",
        email: "jane@acme.com",
      });

      expect(result).toMatchObject({
        partyContactId: "new-contact-id",
        partyId: PARTY_ID,
      });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "party.contact.created",
          userId: USER_ID,
          orgId: ORG_ID,
          resourceType: "party_contact",
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // updateContact — loadContact BOLA guard + audit
  // ---------------------------------------------------------------------------
  describe("updateContact — BOLA guard + audit", () => {
    it("throws 404 when contact belongs to a different tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.updateContact(OTHER_ORG, USER_ID, CONTACT_ID, { firstName: "X" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("applies patch and audit-logs when contact exists", async () => {
      const existing = makeContact();
      const updated = makeContact({ firstName: "Jane Updated" });

      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await svc.updateContact(ORG_ID, USER_ID, CONTACT_ID, {
        firstName: "Jane Updated",
      });

      expect(result).toMatchObject({ firstName: "Jane Updated" });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "party.contact.updated",
          orgId: ORG_ID,
          userId: USER_ID,
          resourceType: "party_contact",
          resourceId: CONTACT_ID,
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // softDeleteContact — loadContact BOLA guard + audit
  // ---------------------------------------------------------------------------
  describe("softDeleteContact — BOLA guard + soft-delete", () => {
    it("throws 404 when contact is in a different tenant (no update)", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.softDeleteContact(OTHER_ORG, USER_ID, CONTACT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("sets deletedAt and audit-logs when contact exists", async () => {
      const existing = makeContact();
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      await svc.softDeleteContact(ORG_ID, USER_ID, CONTACT_ID);

      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: expect.any(Date) }),
      );
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "party.contact.deleted",
          orgId: ORG_ID,
          userId: USER_ID,
          resourceType: "party_contact",
          resourceId: CONTACT_ID,
        }),
      );
    });
  });
});
