import { Module } from "@nestjs/common";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { InvoicesWriteController } from "./invoices-write.controller";
import { InvoicesWriteService } from "./invoices-write.service";
import { InvoicesUpdateService } from "./invoices-update.service";
import { InvoicesPaymentService } from "./invoices-payment.service";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import { InvoicesPostingService } from "./invoices-posting.service";
import { AccountingAdaptersModule } from "../accounting/adapters/accounting-adapters.module";
import { AccountingKernelModule } from "../accounting/kernel/accounting-kernel.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { CrmAutomationStudioModule } from "../crm/automation-studio/crm-automation-studio.module";
import { BillingModule } from "../billing/core/billing.module";

/**
 * The customer invoice lifecycle on `/invoices`.
 *
 * Distinct from the accounting module's AR documents at `/accounting/ar/*`:
 * this one owns the CRM-side `invoices` / `invoice_items` / `payments` tables
 * and their recurring-invoice and collections behaviour. It reaches accounting
 * only through `InvoicesPostingService`, which posts via the anti-corruption
 * layer — `AccountingKernelModule` is imported for `BooksService`/`FxService`,
 * `AccountingAdaptersModule` for `PostingCommandService`.
 */
@Module({
  imports: [
    AccountingAdaptersModule,
    AccountingKernelModule,
    NotificationsModule,
    CrmAutomationStudioModule,
    BillingModule,
  ],
  controllers: [InvoicesController, InvoicesWriteController],
  providers: [
    InvoicesService,
    InvoicesWriteService,
    InvoicesUpdateService,
    InvoicesPaymentService,
    InvoicesLifecycleService,
    InvoicesPostingService,
  ],
  exports: [InvoicesWriteService],
})
export class InvoicesModule {}
