import { Module } from "@nestjs/common";
import { HrWorkflowsModule } from "../workflows/hr-workflows.module";
import { OrgHierarchyModule } from "../../organization/hierarchy/org-hierarchy.module";
import { HrPeopleController } from "./hr-people.controller";
import { HrEmploymentsController } from "./hr-employments.controller";
import { HrEffectiveChangesController } from "./hr-effective-changes.controller";
import { HrEmployeeSubroutesController } from "./hr-employee-subroutes.controller";
import { HrSensitiveController } from "./hr-sensitive.controller";
import { HrAuditController } from "./hr-audit.controller";
import { HrOrgCatalogController } from "./hr-org-catalog.controller";
import { HrOrgStructureCompatController } from "./hr-org-structure-compat.controller";
import { HrCustomFieldsController } from "./hr-custom-fields.controller";
import { HrPeopleService } from "./hr-people.service";
import { HrEmploymentsService } from "./hr-employments.service";
import { HrEmployeeRecordListsService } from "./hr-employee-record-lists.service";
import { HrEffectiveChangesService } from "./hr-effective-changes.service";
import { HrEffectiveChangeApplierService } from "./hr-effective-change-applier.service";
import { HrTimelineService } from "./hr-timeline.service";
import { HrSensitiveService } from "./hr-sensitive.service";
import { HrAuditService } from "./hr-audit.service";
import { HrOrgCatalogService } from "./hr-org-catalog.service";
import { HrCustomFieldsService } from "./hr-custom-fields.service";
import { PersonEmploymentSyncService } from "./person-employment-sync.service";
import { EmploymentBackfillService } from "./employment-backfill.service";
import { EmploymentReconciliationService } from "./employment-reconciliation.service";
import { EmploymentFactsModule } from "../../directory/employment-facts.module";

@Module({
  imports: [HrWorkflowsModule, OrgHierarchyModule, EmploymentFactsModule],
  controllers: [
    HrPeopleController,
    HrEmploymentsController,
    HrEffectiveChangesController,
    HrEmployeeSubroutesController,
    HrSensitiveController,
    HrAuditController,
    HrOrgCatalogController,
    HrOrgStructureCompatController,
    HrCustomFieldsController,
  ],
  providers: [
    HrPeopleService,
    HrEmploymentsService,
    HrEmployeeRecordListsService,
    HrEffectiveChangesService,
    HrEffectiveChangeApplierService,
    HrTimelineService,
    HrSensitiveService,
    HrAuditService,
    HrOrgCatalogService,
    HrCustomFieldsService,
    PersonEmploymentSyncService,
    EmploymentBackfillService,
    EmploymentReconciliationService,
  ],
  exports: [
    HrAuditService,
    HrEffectiveChangesService,
    HrPeopleService,
    HrEmploymentsService,
    HrSensitiveService,
    PersonEmploymentSyncService,
    EmploymentBackfillService,
    EmploymentReconciliationService,
    EmploymentFactsModule,
  ],
})
export class HrCoreModule {}
