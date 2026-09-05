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
const CONTACT_ID = "contact-uuid-1";

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

describe("PartyService — contact CRUD", () => {
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
          const whereChain = { limit: jest.fn().mockResolvedValue([party]) };
          const fromChain = { where: jest.fn().mockReturnValue(whereChain) };
          return { from: jest.fn().mockReturnValue(fromChain) };
        }
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

  describe("updateContact — BOLA guard + audit", () => {
    it("throws 404 when contact belongs to a different tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.updateContact(OTHER_ORG, USER_ID, CONTACT_ID, { firstName: "X" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("returns the existing contact without hitting the DB when no fields are provided (bites if reverted: empty set would throw)", async () => {
      const existing = makeContact();
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const result = await svc.updateContact(ORG_ID, USER_ID, CONTACT_ID, {});

      expect(result).toMatchObject({ partyContactId: CONTACT_ID });
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
      expect(mockAudit.log).not.toHaveBeenCalled();
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
