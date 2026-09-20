import "reflect-metadata";
import { REQUIRE_PERMISSION } from "../../access/require-permission.decorator";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { RecruitmentSelfController } from "./recruitment-self.controller";

const HANDLERS = [
  "listJobOpenings",
  "applyToJobOpening",
  "listOwnReferrals",
  "createOwnReferral",
] as const;

function permissionOf(handler: (typeof HANDLERS)[number]): unknown {
  return Reflect.getMetadata(
    REQUIRE_PERMISSION,
    RecruitmentSelfController.prototype[handler],
  );
}

describe("employee self-service recruitment surface", () => {
  it("exposes exactly the four handlers the §8 entitlement needs", () => {
    for (const handler of HANDLERS)
      expect(typeof RecruitmentSelfController.prototype[handler]).toBe("function");
  });

  it("gates browsing and applying to internal openings on self:job-openings", () => {
    expect(permissionOf("listJobOpenings")).toBe("self:job-openings");
    expect(permissionOf("applyToJobOpening")).toBe("self:job-openings");
  });

  it("gates own referrals on self:referrals", () => {
    expect(permissionOf("listOwnReferrals")).toBe("self:referrals");
    expect(permissionOf("createOwnReferral")).toBe("self:referrals");
  });

  it("carries no module gate — a member in an org without HR enabled keeps their own referrals and openings", () => {
    expect(Reflect.getMetadata(REQUIRE_MODULE, RecruitmentSelfController)).toBeUndefined();
    for (const handler of HANDLERS)
      expect(
        Reflect.getMetadata(REQUIRE_MODULE, RecruitmentSelfController.prototype[handler]),
      ).toBeUndefined();
  });

  it("never gates a self surface on an administrative hr key, which would readmit the bug this replaced", () => {
    for (const handler of HANDLERS)
      expect(String(permissionOf(handler)).startsWith("self:")).toBe(true);
  });
});
