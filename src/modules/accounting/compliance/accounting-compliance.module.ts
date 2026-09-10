import { Module } from "@nestjs/common";
import { AccountingKernelModule } from "../kernel/accounting-kernel.module";
import { ComplianceController } from "./compliance.controller";
import { ComplianceService } from "./compliance.service";

/**
 * E-invoicing state (PRD 13). Fields and status only in v1 — no connector.
 *
 * The controller exists because the state was previously write-only:
 * `ComplianceService.get` had no caller, so the product decided an IRN was owed
 * on every Indian B2B invoice, recorded that, sent nothing, and told nobody.
 */
@Module({
  imports: [AccountingKernelModule],
  controllers: [ComplianceController],
  providers: [ComplianceService],
  exports: [ComplianceService],
})
export class AccountingComplianceModule {}
