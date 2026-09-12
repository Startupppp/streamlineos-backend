import { ConflictException } from "@nestjs/common";
import {
  assertCompatibleLink,
} from "./directory-identity-helpers";
import { DirectoryIdentityService } from "./directory-identity.service";
import { DirectoryPersonEnsureService } from "./directory-person-ensure.service";
import { resolvePerson } from "./person-seam";
import { stubService } from "../../test/service-stub.spec-fixtures";
import type { Db } from "../../db/drizzle.module";

const ORG_ID = "org-canonical";
const OTHER_ORG_ID = "org-other";
const USER_A = "user-alice";
const USER_B = "user-bob";
const MEMBERSHIP_A = 10;
const MEMBERSHIP_B = 20;
const PERSON_ID = "person-canonical";

function makePerson(overrides: Record<string, unknown> = {}) {
  return {
    organizationPersonId: PERSON_ID,
    organizationId: ORG_ID,
    userId: USER_A,
    organizationMembershipId: MEMBERSHIP_A,
    firstName: "Alice",
    lastName: "Canonical",
    displayName: "Alice Canonical",
    preferredName: null,
    workEmail: "alice@example.com",
    personalEmail: null,
    phone: null,
    whatsappNumber: null,
    avatarUrl: null,
    dateOfBirth: null,
    gender: null,
    nationality: null,
    timezone: null,
    languageCode: "en",
    address: null,
    emergencyContact: null,
    linkedinUrl: null,
    githubUrl: null,
    bio: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function limitedSelect(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin, where });
  return { chain: { from }, where, limit };
}

function memberRow(userId: string, membershipId: number, email: string) {
  return {
    membershipId,
    userId,
    email,
    name: null,
    firstName: null,
    lastName: null,
    phone: null,
  };
}

describe("P8 — canonical person/facet linkage", () => {
  describe("assertCompatibleLink — conflicting explicit IDs fail safely", () => {
    it("throws DIRECTORY_PERSON_IDENTITY_CONFLICT when person carries a different userId", () => {
      const person = makePerson({ userId: USER_A, organizationMembershipId: MEMBERSHIP_A });
      const identity = memberRow(USER_B, MEMBERSHIP_A, "alice@example.com");
      expect(() => assertCompatibleLink(person as never, identity)).toThrow(
        ConflictException,
      );
    });

    it("throws DIRECTORY_PERSON_IDENTITY_CONFLICT when person carries a different membershipId AND userId differs", () => {
      const person = makePerson({ userId: USER_A, organizationMembershipId: MEMBERSHIP_A });
      const identity = memberRow(USER_B, MEMBERSHIP_B, "bob@example.com");
      expect(() => assertCompatibleLink(person as never, identity)).toThrow(
        ConflictException,
      );
    });

    it("does NOT throw when same userId resolves a stale membershipId", () => {
      const person = makePerson({ userId: USER_A, organizationMembershipId: MEMBERSHIP_B });
      const identity = memberRow(USER_A, MEMBERSHIP_A, "alice@example.com");
      expect(() => assertCompatibleLink(person as never, identity)).not.toThrow();
    });

    it("does NOT throw when person has no ids yet (not yet linked)", () => {
      const person = makePerson({ userId: null, organizationMembershipId: null });
      const identity = memberRow(USER_A, MEMBERSHIP_A, "alice@example.com");
      expect(() => assertCompatibleLink(person as never, identity)).not.toThrow();
    });
  });

  describe("ensurePersonForMember — same organization_people row is reused", () => {
    it("returns the existing person row without inserting when active person found by userId", async () => {
      const memberResult = memberRow(USER_A, MEMBERSHIP_A, "alice@example.com");
      const existingPerson = makePerson({ userId: USER_A, organizationMembershipId: MEMBERSHIP_A });

      const memberSelect = limitedSelect([memberResult]);
      const activePersonSelect = limitedSelect([existingPerson]);

      const reconciledPerson = { ...existingPerson, organizationMembershipId: MEMBERSHIP_A };
      const reconcilePersonIdentity = jest.fn().mockResolvedValue(reconciledPerson);
      const db = {
        select: jest.fn()
          .mockReturnValueOnce(memberSelect.chain)
          .mockReturnValueOnce(activePersonSelect.chain),
        insert: jest.fn(),
      } as unknown as Db;

      const identityService = stubService<DirectoryIdentityService>({ reconcilePersonIdentity });
      const svc = new DirectoryPersonEnsureService(db, identityService);

      const result = await svc.ensurePersonForMember(ORG_ID, USER_A);

      expect(reconcilePersonIdentity).toHaveBeenCalledWith(ORG_ID, existingPerson);
      expect(db.insert).not.toHaveBeenCalled();
      expect(result.organizationPersonId).toBe(PERSON_ID);
    });

    it("creates a new organization_people row only when no existing active or deleted person exists", async () => {
      const memberResult = memberRow(USER_A, MEMBERSHIP_A, "alice@example.com");
      const memberSelect = limitedSelect([memberResult]);
      const activePersonSelect = limitedSelect([]);
      const deletedPersonSelect = limitedSelect([]);

      const created = makePerson({ userId: USER_A, organizationMembershipId: MEMBERSHIP_A });
      const returning = jest.fn().mockResolvedValue([created]);
      const values = jest.fn().mockReturnValue({ returning });
      const db = {
        select: jest.fn()
          .mockReturnValueOnce(memberSelect.chain)
          .mockReturnValueOnce(activePersonSelect.chain)
          .mockReturnValueOnce(deletedPersonSelect.chain),
        insert: jest.fn().mockReturnValue({ values }),
      } as unknown as Db;

      const identityService = stubService<DirectoryIdentityService>({ reconcilePersonIdentity: jest.fn() });
      const svc = new DirectoryPersonEnsureService(db, identityService);

      const result = await svc.ensurePersonForMember(ORG_ID, USER_A);

      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          userId: USER_A,
          organizationMembershipId: MEMBERSHIP_A,
        }),
      );
      expect(result.organizationPersonId).toBe(PERSON_ID);
    });

    it("two members sharing the same full name but different emails produce separate person records", async () => {
      const memberResultA = memberRow(USER_A, MEMBERSHIP_A, "alice@example.com");
      const memberResultB = memberRow(USER_B, MEMBERSHIP_B, "bob@example.com");

      const memberSelectA = limitedSelect([memberResultA]);
      const activePersonSelectA = limitedSelect([]);
      const deletedPersonSelectA = limitedSelect([]);

      const memberSelectB = limitedSelect([memberResultB]);
      const activePersonSelectB = limitedSelect([]);
      const deletedPersonSelectB = limitedSelect([]);

      const personA = makePerson({ organizationPersonId: "p-alice", userId: USER_A, organizationMembershipId: MEMBERSHIP_A, workEmail: "alice@example.com" });
      const personB = makePerson({ organizationPersonId: "p-bob", userId: USER_B, organizationMembershipId: MEMBERSHIP_B, workEmail: "bob@example.com" });

      const returningA = jest.fn().mockResolvedValue([personA]);
      const valuesA = jest.fn().mockReturnValue({ returning: returningA });
      const dbA = {
        select: jest.fn()
          .mockReturnValueOnce(memberSelectA.chain)
          .mockReturnValueOnce(activePersonSelectA.chain)
          .mockReturnValueOnce(deletedPersonSelectA.chain),
        insert: jest.fn().mockReturnValue({ values: valuesA }),
      } as unknown as Db;

      const returningB = jest.fn().mockResolvedValue([personB]);
      const valuesB = jest.fn().mockReturnValue({ returning: returningB });
      const dbB = {
        select: jest.fn()
          .mockReturnValueOnce(memberSelectB.chain)
          .mockReturnValueOnce(activePersonSelectB.chain)
          .mockReturnValueOnce(deletedPersonSelectB.chain),
        insert: jest.fn().mockReturnValue({ values: valuesB }),
      } as unknown as Db;

      const svcA = new DirectoryPersonEnsureService(dbA, stubService<DirectoryIdentityService>({ reconcilePersonIdentity: jest.fn() }));
      const svcB = new DirectoryPersonEnsureService(dbB, stubService<DirectoryIdentityService>({ reconcilePersonIdentity: jest.fn() }));

      const resultA = await svcA.ensurePersonForMember(ORG_ID, USER_A);
      const resultB = await svcB.ensurePersonForMember(ORG_ID, USER_B);

      expect(resultA.organizationPersonId).toBe("p-alice");
      expect(resultB.organizationPersonId).toBe("p-bob");
      expect(resultA.organizationPersonId).not.toBe(resultB.organizationPersonId);
      expect(valuesA).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_A }));
      expect(valuesB).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_B }));
    });
  });

  describe("reconcilePersonIdentity — accepts invitation keeps same person row", () => {
    it("updates userId and membershipId on the same person row without creating a new one", async () => {
      const identity = memberRow(USER_A, MEMBERSHIP_A, "alice@example.com");
      const personBeforeAccept = makePerson({ userId: null, organizationMembershipId: null });
      const personAfterReconcile = { ...personBeforeAccept, userId: USER_A, organizationMembershipId: MEMBERSHIP_A };

      const memberSelect = limitedSelect([identity]);
      const personSelect = limitedSelect([personBeforeAccept]);

      const returning = jest.fn().mockResolvedValue([personAfterReconcile]);
      const where = jest.fn().mockReturnValue({ returning });
      const set = jest.fn().mockReturnValue({ where });

      const db = {
        select: jest.fn()
          .mockReturnValueOnce(memberSelect.chain)
          .mockReturnValueOnce(personSelect.chain),
        update: jest.fn().mockReturnValue({ set }),
        insert: jest.fn(),
      } as unknown as Db;

      const svc = new DirectoryIdentityService(db);

      const result = await svc.reconcilePersonIdentity(ORG_ID, personBeforeAccept as never);

      expect(result.organizationPersonId).toBe(PERSON_ID);
      expect(set).toHaveBeenCalledWith({ userId: USER_A, organizationMembershipId: MEMBERSHIP_A });
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe("person-seam cross-tenant isolation", () => {
    it("resolves unresolved when a user subject belongs to a different org", async () => {
      const db = {
        query: {
          organizationMembers: {
            findFirst: jest.fn().mockResolvedValue(null),
          },
        },
        select: jest.fn(() => {
          const link: Record<string, unknown> = {};
          for (const m of ["from", "innerJoin", "leftJoin", "where"])
            link[m] = () => link;
          link["limit"] = () => Promise.resolve([]);
          return link;
        }),
      } as unknown as Db;

      const resolution = await resolvePerson(db, OTHER_ORG_ID, { kind: "user", userId: USER_A });
      expect(resolution.status).toBe("unresolved");
    });

    it("resolves unresolved when a person record belongs to a different org", async () => {
      const db = {
        query: {
          organizationMembers: {
            findFirst: jest.fn().mockResolvedValue(null),
          },
        },
        select: jest.fn(() => {
          const link: Record<string, unknown> = {};
          for (const m of ["from", "innerJoin", "leftJoin", "where"])
            link[m] = () => link;
          link["limit"] = () => Promise.resolve([]);
          return link;
        }),
      } as unknown as Db;

      const resolution = await resolvePerson(db, OTHER_ORG_ID, { kind: "person", organizationPersonId: PERSON_ID });
      expect(resolution.status).toBe("unresolved");
    });

    it("resolves unresolved when a worker subject belongs to a different org", async () => {
      const db = {
        query: {
          organizationMembers: {
            findFirst: jest.fn().mockResolvedValue(null),
          },
        },
        select: jest.fn(() => {
          const link: Record<string, unknown> = {};
          for (const m of ["from", "innerJoin", "leftJoin", "where"])
            link[m] = () => link;
          link["limit"] = () => Promise.resolve([]);
          return link;
        }),
      } as unknown as Db;

      const resolution = await resolvePerson(db, OTHER_ORG_ID, { kind: "worker", workerId: "w-1" });
      expect(resolution.status).toBe("unresolved");
    });
  });
});
