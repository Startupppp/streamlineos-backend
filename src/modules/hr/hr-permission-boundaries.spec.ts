import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import { HrCustomFieldsController } from "./core/hr-custom-fields.controller";
import { HrOrgStructureCompatController } from "./core/hr-org-structure-compat.controller";
import { BackgroundVerificationController } from "./directory/background-verification.controller";
import { HrGovernanceDelegationsController } from "./governance/delegations/delegations.controller";
import { RecruitmentPipelineController } from "./recruitment/recruitment-pipeline.controller";
import { EmployeesController } from "./directory/employees.controller";
import { HrOnboardingAdminController } from "./onboarding/core/hr-onboarding-admin.controller";
import { LeavesController } from "./time/leaves.controller";

function permissionFor(handler: object): string | undefined {
  return Reflect.getMetadata(REQUIRE_PERMISSION, handler);
}

describe("HR least-privilege controller boundaries", () => {
  it("does not infer proxy delegation access from employee permissions", () => {
    expect(permissionFor(HrGovernanceDelegationsController.prototype.listMy)).toBe(
      "hr:workflows:view",
    );
    expect(permissionFor(HrGovernanceDelegationsController.prototype.listOrg)).toBe(
      "hr:workflows:manage",
    );
    expect(permissionFor(HrGovernanceDelegationsController.prototype.create)).toBe(
      "hr:workflows:view",
    );
    expect(permissionFor(HrGovernanceDelegationsController.prototype.update)).toBe(
      "hr:workflows:view",
    );
    expect(permissionFor(HrGovernanceDelegationsController.prototype.revoke)).toBe(
      "hr:workflows:view",
    );
  });

  it("protects background screening as sensitive HR data", () => {
    expect(
      permissionFor(BackgroundVerificationController.prototype.list),
    ).toBe("hr:sensitive:view");
    expect(
      permissionFor(BackgroundVerificationController.prototype.create),
    ).toBe("hr:sensitive:manage");
    expect(
      permissionFor(BackgroundVerificationController.prototype.update),
    ).toBe("hr:sensitive:manage");
    expect(
      permissionFor(RecruitmentPipelineController.prototype.bgvCompliance),
    ).toBe("hr:sensitive:view");
  });

  it("gates field definitions on HR's own namespace, not global settings", () => {
    expect(
      permissionFor(HrCustomFieldsController.prototype.listDefinitions),
    ).toBe("hr:custom-fields:manage");
    expect(
      permissionFor(HrCustomFieldsController.prototype.createDefinition),
    ).toBe("hr:custom-fields:manage");
    expect(
      permissionFor(HrCustomFieldsController.prototype.updateDefinition),
    ).toBe("hr:custom-fields:manage");
    expect(
      permissionFor(HrCustomFieldsController.prototype.deleteDefinition),
    ).toBe("hr:custom-fields:manage");

    expect(permissionFor(HrCustomFieldsController.prototype.getValues)).toBe(
      "hr:employees:view",
    );
    expect(
      permissionFor(HrCustomFieldsController.prototype.upsertValues),
    ).toBe("hr:employees:update");
  });

  it("leaves organisation structure on global settings — hierarchy is global administration", () => {
    const controller = HrOrgStructureCompatController.prototype;
    for (const handler of [controller.listLocations, controller.listTeams])
      expect(permissionFor(handler)).toBe("settings:view");
    for (const handler of [
      controller.createLocation,
      controller.updateLocation,
      controller.createTeam,
      controller.updateTeam,
    ])
      expect(permissionFor(handler)).toBe("settings:organization:manage");
  });

  it("uses the dedicated onboarding permission for the complete hiring flow", () => {
    expect(permissionFor(EmployeesController.prototype.onboard)).toBe(
      "hr:onboarding:manage",
    );
    expect(permissionFor(EmployeesController.prototype.onboardBulk)).toBe(
      "hr:onboarding:manage",
    );
    expect(permissionFor(EmployeesController.prototype.checkEmail)).toBe(
      "hr:onboarding:manage",
    );
    expect(permissionFor(EmployeesController.prototype.resendInvite)).toBe(
      "hr:onboarding:manage",
    );
    expect(permissionFor(HrOnboardingAdminController.prototype.sendReminders)).toBe(
      "hr:onboarding:manage",
    );
  });

  it("separates leave self-service from approval and comp-off authority", () => {
    expect(permissionFor(LeavesController.prototype.update)).toBe(
      "hr:leaves:approve",
    );
    expect(permissionFor(LeavesController.prototype.compOff)).toBe(
      "hr:leaves:manage",
    );
  });
});
