import { Module } from "@nestjs/common";
import { EmploymentFactsModule } from "../../directory/employment-facts.module";
import { HrAuditService } from "./hr-audit.service";
import { PersonEmploymentSyncService } from "./person-employment-sync.service";
import { EmploymentBackfillService } from "./employment-backfill.service";
import { EmploymentReconciliationService } from "./employment-reconciliation.service";

@Module({
  imports: [EmploymentFactsModule],
  providers: [
    HrAuditService,
    PersonEmploymentSyncService,
    EmploymentBackfillService,
    EmploymentReconciliationService,
  ],
  exports: [
    HrAuditService,
    PersonEmploymentSyncService,
    EmploymentBackfillService,
    EmploymentReconciliationService,
  ],
})
export class EmploymentMigrationModule {}
