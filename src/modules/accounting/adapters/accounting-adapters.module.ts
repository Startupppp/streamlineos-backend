import { Module } from "@nestjs/common";
import { AccountingKernelModule } from "../kernel/accounting-kernel.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { WebhooksModule } from "../../webhooks/webhooks.module";
import { JournalPostedConsumer } from "./journal-posted.consumer";
import { PostingCommandService } from "./posting-command.service";
import { StockMovementBridgeService } from "./stock-movement-bridge.service";
import { ReconciliationController } from "./reconciliation/reconciliation.controller";
import { StockGlReconciliationService } from "./reconciliation/stock-gl-reconciliation.service";
import { UnpostedMovementsService } from "./reconciliation/unposted-movements.service";

/**
 * Accounting-side adapters.
 *
 * Integration in v1 means **listening**, never reaching into another module.
 * Nothing here is imported by Billing, Payroll or CRM, and no commit in this
 * rewrite touches their write paths — the working agreement is explicit that
 * discovering an event name does not authorise editing the module that emits it.
 *
 * If those modules never emit, accounting still ships: it is standalone by
 * design, and `PostingCommandService` simply has no callers.
 */
@Module({
  imports: [AccountingKernelModule, OutboxModule, WebhooksModule],
  controllers: [ReconciliationController],
  providers: [
    // Registers accounting.journal.posted with the outbox; see its docblock.
    JournalPostedConsumer,
    PostingCommandService,
    StockMovementBridgeService,
    UnpostedMovementsService,
    StockGlReconciliationService,
  ],
  exports: [
    PostingCommandService,
    StockMovementBridgeService,
    UnpostedMovementsService,
    StockGlReconciliationService,
  ],
})
export class AccountingAdaptersModule {}
