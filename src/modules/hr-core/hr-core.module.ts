import { Module } from "@nestjs/common";
import { HrWorkflowsModule } from "../hr-workflows/hr-workflows.module";
import { HrPeopleController } from "./hr-people.controller";
import { HrEmploymentsController } from "./hr-employments.controller";
import { HrEffectiveChangesController } from "./hr-effective-changes.controller";
import { HrEmployeeSubroutesController } from "./hr-employee-subroutes.controller";
import { HrSensitiveController } from "./hr-sensitive.controller";
import { HrAuditController } from "./hr-audit.controller";
import { HrOrgCatalogController } from "./hr-org-catalog.controller";
import { HrPeopleService } from "./hr-people.service";
import { HrEmploymentsService } from "./hr-employments.service";
import { HrEffectiveChangesService } from "./hr-effective-changes.service";
import { HrTimelineService } from "./hr-timeline.service";
import { HrSensitiveService } from "./hr-sensitive.service";
import { HrAuditService } from "./hr-audit.service";
import { HrOrgCatalogService } from "./hr-org-catalog.service";

@Module({
  imports: [HrWorkflowsModule],
  controllers: [
    HrPeopleController,
    HrEmploymentsController,
    HrEffectiveChangesController,
    HrEmployeeSubroutesController,
    HrSensitiveController,
    HrAuditController,
    HrOrgCatalogController,
  ],
  providers: [
    HrPeopleService,
    HrEmploymentsService,
    HrEffectiveChangesService,
    HrTimelineService,
    HrSensitiveService,
    HrAuditService,
    HrOrgCatalogService,
  ],
  exports: [HrAuditService, HrEffectiveChangesService, HrPeopleService, HrEmploymentsService, HrSensitiveService],
})
export class HrCoreModule {}
