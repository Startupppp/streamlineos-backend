import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PortalAccessService } from "./portal-access.service";

describe("PortalAccessService.createGrant", () => {
  const organizationId = "org-1";
  const actorUserId = "admin-1";

  function createService(options: {
    membership?: { partyContactId: string; status: string };
    project?: { id: number; pmWorkspaceId: string | null } | null;
  }) {
    let selectCall = 0;
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
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            {
              projectClientGrantId: "grant-1",
              organizationId,
              portalMembershipId: "pm-1",
              partyContactId: "contact-1",
              projectId: 10,
              pmWorkspaceId: "ws-1",
              status: "ACTIVE",
            },
          ]),
        }),
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
});
