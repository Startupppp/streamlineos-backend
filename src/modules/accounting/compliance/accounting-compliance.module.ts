import { Module } from "@nestjs/common";
import { AccountingKernelModule } from "../kernel/accounting-kernel.module";
import { ComplianceController } from "./compliance.controller";
import { ComplianceService } from "./compliance.service";
import { ComplianceTransportRegistry } from "./transport/compliance-transport.registry";
import { LiveIrpAdapter } from "./transport/live-irp.adapter";
import { MockIrpAdapter } from "./transport/mock-irp.adapter";

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
  /*
    Both adapters are constructed in every deployment; which one — if either —
    is reachable is `ComplianceTransportRegistry`'s decision, and it is made
    from configuration rather than from what happens to be in the container.
    `LiveIrpAdapter` with no credentials is inert: it answers `isConfigured()`
    false and the registry never hands it out.
  */
  providers: [ComplianceService, ComplianceTransportRegistry, MockIrpAdapter, LiveIrpAdapter],
  exports: [ComplianceService, ComplianceTransportRegistry],
})
export class AccountingComplianceModule {}
