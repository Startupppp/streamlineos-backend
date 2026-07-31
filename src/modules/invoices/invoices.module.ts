import { Module } from "@nestjs/common";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { InvoicesWriteController } from "./invoices-write.controller";
import { InvoicesWriteService } from "./invoices-write.service";
import { InvoicesUpdateService } from "./invoices-update.service";
import { InvoicesPaymentService } from "./invoices-payment.service";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import { AccountingModule } from "../accounting/core/accounting.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { CrmAutomationStudioModule } from "../crm/automation-studio/crm-automation-studio.module";
import { FinanceControlsModule } from "../finance/controls/finance-controls.module";
import { BillingModule } from "../billing/core/billing.module";

@Module({
  imports: [AccountingModule, NotificationsModule, CrmAutomationStudioModule, FinanceControlsModule, BillingModule],
  controllers: [InvoicesController, InvoicesWriteController],
  providers: [InvoicesService, InvoicesWriteService, InvoicesUpdateService, InvoicesPaymentService, InvoicesLifecycleService],
  exports: [InvoicesWriteService],
})
export class InvoicesModule {}
