import { Module } from "@nestjs/common";
import { OrgHierarchyController } from "./org-hierarchy.controller";
import { OrgHierarchyMovesController } from "./org-hierarchy-moves.controller";
import { OrgHierarchyService } from "./org-hierarchy.service";
import { OrgHierarchyBusinessUnitsService } from "./org-hierarchy-business-units.service";
import { OrgHierarchyBranchesService } from "./org-hierarchy-branches.service";
import { OrgHierarchyDepartmentsService } from "./org-hierarchy-departments.service";
import { OrgHierarchyTeamsService } from "./org-hierarchy-teams.service";
import { OrgHierarchyLocationsService } from "./org-hierarchy-locations.service";
import { OrgHierarchyCostCentersService } from "./org-hierarchy-cost-centers.service";
import { OrgHierarchyDependenciesService } from "./org-hierarchy-dependencies.service";
import { OrgHierarchyCommandService } from "./org-hierarchy-command.service";
import { OrgHierarchyReadService } from "./org-hierarchy-read.service";
import { OrgHierarchyTreeSourceService } from "./org-hierarchy-tree-source.service";

@Module({
  controllers: [OrgHierarchyController, OrgHierarchyMovesController],
  providers: [
    OrgHierarchyService,
    OrgHierarchyBusinessUnitsService,
    OrgHierarchyBranchesService,
    OrgHierarchyDepartmentsService,
    OrgHierarchyTeamsService,
    OrgHierarchyLocationsService,
    OrgHierarchyCostCentersService,
    OrgHierarchyDependenciesService,
    OrgHierarchyCommandService,
    OrgHierarchyReadService,
    OrgHierarchyTreeSourceService,
  ],
  exports: [OrgHierarchyService],
})
export class OrgHierarchyModule {}
