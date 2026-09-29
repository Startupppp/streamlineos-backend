import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import { PortalAccessService } from "./portal-access.service";

const NO_PARTY_SERVICE = undefined as never;

describe("PortalAccessService.createGrant", () => {
  const organizationId = "org-1";
  const actorUserId = "admin-1";

  function createService(options: {
    membership?: { partyContactId: string; status: string };
    project?: { id: number } | null;
    insertError?: Error;
  }) {
    let selectCall = 0;
    const returning = options.insertError
      ? jest.fn().mockRejectedValue(options.insertError)
      : jest.fn().mockResolvedValue([
          {
            projectClientGrantId: "grant-1",
            organizationId,
            portalMembershipId: "pm-1",
            partyContactId: "contact-1",
            projectId: 10,
            status: "ACTIVE",
          },
        ]);
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockImplementation(() => {
              selectCall += 1;
              if (selectCall === 1) {
                return Promise.resolve(options.membership ? [options.membership] : []);
              }
              return Promise.resolve(options.project ? [options.project] : []);
            }),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning }),
      }),
    };
    const audit = { log: jest.fn() };
    return new PortalAccessService(db as never, audit as never, NO_PARTY_SERVICE);
  }

  it("rejects grant when portal membership is not active", async () => {
    const service = createService({
      membership: { partyContactId: "contact-1", status: "PENDING" },
      project: { id: 10 },
    });
    await expect(
      service.createGrant(organizationId, actorUserId, {
        portalMembershipId: "pm-1",
        projectId: 10,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects grant when project is missing", async () => {
    const service = createService({
      membership: { partyContactId: "contact-1", status: "ACTIVE" },
      project: null,
    });
    await expect(
      service.createGrant(organizationId, actorUserId, {
        portalMembershipId: "pm-1",
        projectId: 10,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("answers 409 when the grant insert hits a unique violation", async () => {
    const service = createService({
      membership: { partyContactId: "contact-1", status: "ACTIVE" },
      project: { id: 10 },
      insertError: drizzleUniqueViolation(),
    });
    await expect(
      service.createGrant(organizationId, actorUserId, {
        portalMembershipId: "pm-1",
        projectId: 10,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("PortalAccessService.createMembership", () => {
  const organizationId = "org-1";
  const actorUserId = "admin-1";

  function createService(insertError: Error) {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ partyContactId: "contact-1" }]),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(insertError),
        }),
      }),
    };
    return new PortalAccessService(db as never, { log: jest.fn() } as never, NO_PARTY_SERVICE);
  }

  it("answers 409 when the contact already has a live membership", async () => {
    const service = createService(
      drizzleUniqueViolation("uniq_portal_memberships_org_contact_audience"),
    );
    await expect(
      service.createMembership(organizationId, actorUserId, { partyContactId: "contact-1" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "fk_portal_memberships_org_contact");
    const service = createService(fkViolation);
    await expect(
      service.createMembership(organizationId, actorUserId, { partyContactId: "contact-1" }),
    ).rejects.toBe(fkViolation);
  });
});

describe("PortalAccessService.inviteClient", () => {
  const organizationId = "org-1";
  const actorUserId = "admin-1";

  const createdParty = { partyId: "party-1", organizationId };
  const createdContact = { partyContactId: "contact-1", partyId: "party-1", organizationId };
  const createdMembership = {
    portalMembershipId: "pm-1",
    organizationId,
    partyContactId: "contact-1",
    status: "ACTIVE",
    sessionEpoch: 0,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function createService(options: { insertError?: Error } = {}) {
    const returning = options.insertError
      ? jest.fn().mockRejectedValue(options.insertError)
      : jest.fn().mockResolvedValue([createdMembership]);
    const db = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning }),
      }),
    };
    const audit = { log: jest.fn() };
    const partyService = {
      createParty: jest.fn().mockResolvedValue(createdParty),
      createContact: jest.fn().mockResolvedValue(createdContact),
    };
    return {
      service: new PortalAccessService(db as never, audit as never, partyService as never),
      db,
      audit,
      partyService,
    };
  }

  it("creates a party, contact, and ACTIVE portal membership in sequence", async () => {
    const { service, partyService, db } = createService();
    const result = await service.inviteClient(organizationId, actorUserId, {
      firstName: "Jane",
      lastName: "Smith",
      email: "jane@example.com",
    });
    expect(partyService.createParty).toHaveBeenCalledWith(
      organizationId,
      actorUserId,
      expect.objectContaining({ name: "Jane Smith", partyKind: "PERSON" }),
    );
    expect(partyService.createContact).toHaveBeenCalledWith(
      organizationId,
      actorUserId,
      expect.objectContaining({ partyId: "party-1", firstName: "Jane" }),
    );
    expect(db.insert).toHaveBeenCalled();
    expect(result.status).toBe("ACTIVE");
    expect(result.partyContactId).toBe("contact-1");
  });

  it("returns the membership row so the caller can select it in the grant form without a second round-trip", async () => {
    const { service } = createService();
    const result = await service.inviteClient(organizationId, actorUserId, {
      firstName: "Alice",
    });
    expect(result.portalMembershipId).toBe("pm-1");
    expect(result.status).toBe("ACTIVE");
  });

  it("answers 409 when the contact already has a portal membership", async () => {
    const { service } = createService({
      insertError: drizzleUniqueViolation("uniq_portal_memberships_org_contact_audience"),
    });
    await expect(
      service.inviteClient(organizationId, actorUserId, { firstName: "Bob" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
