import { BadRequestException } from "@nestjs/common";
import { OrganizationController } from "./organization.controller";
import type { OrganizationService } from "./organization.service";
import type { OrganizationSettingsService } from "./organization-settings.service";
import type { InvitationsService } from "./invitations.service";
import type { InvitationsReadService } from "./invitations-read.service";
import type { InvitationAcceptanceService } from "./invitation-acceptance.service";
import type { RateLimitService } from "../../../common/ratelimit/rate-limit.service";
import type { OrganizationLegalHoldService } from "./lifecycle/organization-legal-hold.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreateOrganizationInput, SwitchOrgInput } from "./dto/organization.schemas";

const ORG_RESULT = { id: "org-new", name: "New Org", slug: "new-org" };
const NEW_ORG_BODY: CreateOrganizationInput = { name: "New Org", slug: "new-org", billingEmail: null };

function userContext(role: string, isOrgOwner: boolean): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-a",
    role,
    isOrgOwner,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner },
  };
}

function buildController(switchOrgImpl?: () => Promise<unknown>) {
  const createOrganization = jest.fn().mockResolvedValue(ORG_RESULT);
  const switchOrg = switchOrgImpl
    ? jest.fn().mockImplementation(switchOrgImpl)
    : jest.fn().mockResolvedValue({ orgId: "org-b" });

  const organization = { createOrganization, switchOrg } as unknown as OrganizationService;

  const controller = new OrganizationController(
    organization,
    {} as unknown as OrganizationSettingsService,
    {} as unknown as InvitationsService,
    {} as unknown as InvitationsReadService,
    {} as unknown as InvitationAcceptanceService,
    {} as unknown as RateLimitService,
    {} as unknown as OrganizationLegalHoldService,
  );

  return { controller, createOrganization, switchOrg };
}

describe("OrganizationController — org creation policy", () => {
  it("allows a plain member (MEMBER role) to create a new organisation", async () => {
    const { controller, createOrganization } = buildController();
    const u = userContext("MEMBER", false);

    const result = await controller.createOrganization(NEW_ORG_BODY, u);

    expect(result).toEqual(ORG_RESULT);
    expect(createOrganization).toHaveBeenCalledWith(u.userId, NEW_ORG_BODY);
  });

  it("allows an org admin (ORG_ADMIN role) to create a new organisation", async () => {
    const { controller, createOrganization } = buildController();
    const u = userContext("ORG_ADMIN", false);

    const result = await controller.createOrganization(NEW_ORG_BODY, u);

    expect(result).toEqual(ORG_RESULT);
    expect(createOrganization).toHaveBeenCalledWith(u.userId, NEW_ORG_BODY);
  });

  it("allows an org owner to create a new organisation", async () => {
    const { controller, createOrganization } = buildController();
    const u = userContext("OWNER", true);

    const result = await controller.createOrganization(NEW_ORG_BODY, u);

    expect(result).toEqual(ORG_RESULT);
    expect(createOrganization).toHaveBeenCalledWith(u.userId, NEW_ORG_BODY);
  });
});

describe("OrganizationController — switch membership enforcement", () => {
  it("propagates BadRequestException from OrgProfileService when the user is not a member of the target org", async () => {
    const { controller } = buildController(async () => {
      throw new BadRequestException("You are not a member of this organization");
    });
    const u = userContext("MEMBER", false);
    const body: SwitchOrgInput = { orgId: "org-b" };

    await expect(controller.switchOrg(body, u)).rejects.toThrow(BadRequestException);
  });
});
