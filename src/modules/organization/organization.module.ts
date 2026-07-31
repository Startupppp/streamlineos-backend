import { Module } from "@nestjs/common";
import { OrganizationModule } from "./core/organization.module";
import { OrgModule } from "./setup/org.module";
import { OrgHierarchyModule } from "./hierarchy/org-hierarchy.module";
import { WorkspaceOnboardingModule } from "./onboarding/workspace-onboarding.module";

const ORGANIZATION_MODULES = [OrganizationModule, OrgModule, OrgHierarchyModule, WorkspaceOnboardingModule];

@Module({
  imports: ORGANIZATION_MODULES,
  exports: ORGANIZATION_MODULES,
})
export class OrganizationRootModule {}
