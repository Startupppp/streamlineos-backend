import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import { PortalAccessService } from "./portal-access.service";

describe("PortalAccessService.createGrant", () => {
  const organizationId = "org-1";
  const actorUserId = "admin-1";

  function createService(options: {
    membership?: { partyContactId: string; status: string };
    project?: { id: number; pmWorkspaceId: string | null } | null;
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
            pmWorkspaceId: "ws-1",
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
    return new PortalAccessService(db as never, audit as never);
  }

  it("rejects grant when portal membership is not active", async () => {
    const service = createService({
      membership: { partyContactId: "contact-1", status: "PENDING" },
      project: { id: 10, pmWorkspaceId: "ws-1" },
    });
    await expect(
      service.createGrant(organizationId, actorUserId, {
        portalMembershipId: "pm-1",
        projectId: 10,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects grant when pm workspace does not match project", async () => {
    const service = createService({
      membership: { partyContactId: "contact-1", status: "ACTIVE" },
      project: { id: 10, pmWorkspaceId: "ws-1" },
    });
    await expect(
      service.createGrant(organizationId, actorUserId, {
        portalMembershipId: "pm-1",
        projectId: 10,
        pmWorkspaceId: "ws-other",
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
    // Inert today: the only unique on project_client_grants is (organization_id,
    // project_client_grant_id), a generated id, so no (membership, project) duplicate
    // raises 23505. This holds the read, not the index.
    const service = createService({
      membership: { partyContactId: "contact-1", status: "ACTIVE" },
      project: { id: 10, pmWorkspaceId: "ws-1" },
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
    return new PortalAccessService(db as never, { log: jest.fn() } as never);
  }

  it("answers 409 when the contact already has a live membership", async () => {
    // uniq_portal_memberships_org_contact_audience (migration 0307), as drizzle surfaces it.
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
