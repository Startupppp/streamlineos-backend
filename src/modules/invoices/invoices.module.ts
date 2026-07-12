import { Module } from "@nestjs/common";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { InvoicesWriteController } from "./invoices-write.controller";
import { InvoicesWriteService } from "./invoices-write.service";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import { AccountingModule } from "../accounting/accounting.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { CrmAutomationStudioModule } from "../crm-automation-studio/crm-automation-studio.module";

@Module({
  imports: [AccountingModule, NotificationsModule, CrmAutomationStudioModule],
  controllers: [InvoicesController, InvoicesWriteController],
  providers: [InvoicesService, InvoicesWriteService, InvoicesLifecycleService],
  exports: [InvoicesWriteService],
})
export class InvoicesModule {}
