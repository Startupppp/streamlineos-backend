import { Module } from "@nestjs/common";
import { ComplianceService } from "./compliance.service";

/**
 * E-invoicing state (PRD 13). Fields and status only in v1 — no connector.
 */
@Module({
  providers: [ComplianceService],
  exports: [ComplianceService],
})
export class AccountingComplianceModule {}
