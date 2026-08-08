import { Module } from "@nestjs/common";
import { OrgHierarchyController } from "./org-hierarchy.controller";
import { OrgHierarchyService } from "./org-hierarchy.service";
import { OrgHierarchyBusinessUnitsService } from "./org-hierarchy-business-units.service";
import { OrgHierarchyBranchesService } from "./org-hierarchy-branches.service";
import { OrgHierarchyDepartmentsService } from "./org-hierarchy-departments.service";
import { OrgHierarchyTeamsService } from "./org-hierarchy-teams.service";
import { OrgHierarchyLocationsService } from "./org-hierarchy-locations.service";
import { OrgHierarchyCostCentersService } from "./org-hierarchy-cost-centers.service";
import { OrgHierarchyDependenciesService } from "./org-hierarchy-dependencies.service";

@Module({
  controllers: [OrgHierarchyController],
  providers: [
    OrgHierarchyService,
    OrgHierarchyBusinessUnitsService,
    OrgHierarchyBranchesService,
    OrgHierarchyDepartmentsService,
    OrgHierarchyTeamsService,
    OrgHierarchyLocationsService,
    OrgHierarchyCostCentersService,
    OrgHierarchyDependenciesService,
  ],
  exports: [OrgHierarchyService],
})
export class OrgHierarchyModule {}
