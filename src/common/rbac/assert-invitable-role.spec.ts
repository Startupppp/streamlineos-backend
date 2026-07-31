import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { assertInvitableRole } from "./assert-invitable-role";
import { ORG_MEMBER_ROLES } from "./org-roles";

const OWNER_ACTOR = { isOrgOwner: true, isOrgAdmin: false };
const ADMIN_ACTOR = { isOrgOwner: false, isOrgAdmin: true };
const PLAIN_ACTOR = { isOrgOwner: false, isOrgAdmin: false };

describe("assertInvitableRole", () => {
  it("rejects a role outside the three structural values", () => {
    expect(() => assertInvitableRole(OWNER_ACTOR, "HR")).toThrow(BadRequestException);
    expect(() => assertInvitableRole(OWNER_ACTOR, "CEO")).toThrow(BadRequestException);
    expect(() => assertInvitableRole(OWNER_ACTOR, "ADMIN")).toThrow(BadRequestException);
  });

  it("never allows OWNER to be granted, not even by the owner", () => {
    expect(() => assertInvitableRole(OWNER_ACTOR, ORG_MEMBER_ROLES.OWNER)).toThrow(
      ForbiddenException,
    );
    expect(() => assertInvitableRole(ADMIN_ACTOR, ORG_MEMBER_ROLES.OWNER)).toThrow(
      ForbiddenException,
    );
  });

  it("blocks a plain member from minting an ORG_ADMIN", () => {
    // POST /users/invite is gated on hr:employees:create, so an HR user reaches
    // this code — without the guard they could grant themselves a colleague
    // full org-admin permissions.
    expect(() => assertInvitableRole(PLAIN_ACTOR, ORG_MEMBER_ROLES.ORG_ADMIN)).toThrow(
      ForbiddenException,
    );
  });

  it("lets an owner or an existing org admin grant ORG_ADMIN", () => {
    expect(() => assertInvitableRole(OWNER_ACTOR, ORG_MEMBER_ROLES.ORG_ADMIN)).not.toThrow();
    expect(() => assertInvitableRole(ADMIN_ACTOR, ORG_MEMBER_ROLES.ORG_ADMIN)).not.toThrow();
  });

  it("lets anyone with invite rights grant MEMBER", () => {
    expect(() => assertInvitableRole(PLAIN_ACTOR, ORG_MEMBER_ROLES.MEMBER)).not.toThrow();
    expect(() => assertInvitableRole(ADMIN_ACTOR, ORG_MEMBER_ROLES.MEMBER)).not.toThrow();
    expect(() => assertInvitableRole(OWNER_ACTOR, ORG_MEMBER_ROLES.MEMBER)).not.toThrow();
  });
});
