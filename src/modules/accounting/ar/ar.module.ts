import { Module } from "@nestjs/common";
import { AccountingKernelModule } from "../kernel/accounting-kernel.module";
import { AccountingTaxModule } from "../tax/accounting-tax.module";
import { PartiesModule } from "../parties/parties.module";
import { AccountingComplianceModule } from "../compliance/accounting-compliance.module";
import { ArAgingController } from "./ar-aging.controller";
import { ArAgingService } from "./ar-aging.service";
import { ArCreditNotesController } from "./ar-credit-notes.controller";
import { ArDocumentPdfService } from "./ar-document-pdf.service";
import { ArDocumentsService } from "./ar-documents.service";
import { ArInvoicesController } from "./ar-invoices.controller";
import { ArReceiptsController } from "./ar-receipts.controller";
import { ArReceiptsService } from "./ar-receipts.service";

/**
 * Sales / AR — invoices, credit notes, receipts, allocations and aging.
 *
 * The arrows point downward only: AR imports the kernel (to post), tax (to
 * determine) and parties (to know who is being billed). Nothing imports AR
 * except the adapters layer.
 *
 * Not registered in `app.module.ts` from here — `AccountingRootModule` wires it.
 */
@Module({
  imports: [
    AccountingKernelModule,
    AccountingTaxModule,
    PartiesModule,
    AccountingComplianceModule,
  ],
  controllers: [
    ArInvoicesController,
    ArCreditNotesController,
    ArReceiptsController,
    ArAgingController,
  ],
  providers: [ArDocumentsService, ArDocumentPdfService, ArReceiptsService, ArAgingService],
  exports: [ArDocumentsService, ArDocumentPdfService, ArReceiptsService, ArAgingService],
})
export class ArModule {}
