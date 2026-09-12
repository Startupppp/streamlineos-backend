import { Module } from "@nestjs/common";
import { AccountingKernelModule } from "../kernel/accounting-kernel.module";
import { AccountingTaxModule } from "../tax/accounting-tax.module";
import { ApAgingController } from "./ap-aging.controller";
import { ApAgingService } from "./ap-aging.service";
import { ApDocumentsController } from "./ap-documents.controller";
import { ApDocumentsService } from "./ap-documents.service";
import { ApPaymentsController } from "./ap-payments.controller";
import { ApPaymentsService } from "./ap-payments.service";
import { WithholdingEngineRegistry } from "./withholding/withholding.registry";

/**
 * Purchases / AP (PRD 03) — bills, debit notes, payments, withholding, aging.
 *
 * Depends downward only: the kernel for posting and account resolution, the tax
 * module for determination. It posts through `LedgerService` and writes no
 * journal line of its own.
 *
 * `WithholdingEngineRegistry` lives here rather than in the tax module on
 * purpose (PRD 10 S3): withholding is a **sibling** of VAT/GST determination,
 * answering a different question at a different moment on a different base.
 *
 * Registration in `app.module.ts` is deliberately not done here.
 */
@Module({
  imports: [AccountingKernelModule, AccountingTaxModule],
  controllers: [ApDocumentsController, ApPaymentsController, ApAgingController],
  providers: [
    WithholdingEngineRegistry,
    ApDocumentsService,
    ApPaymentsService,
    ApAgingService,
  ],
  exports: [ApDocumentsService, ApPaymentsService, ApAgingService, WithholdingEngineRegistry],
})
export class ApModule {}
