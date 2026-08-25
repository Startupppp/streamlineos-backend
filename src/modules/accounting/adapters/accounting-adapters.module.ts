import { Module } from "@nestjs/common";
import { AccountingKernelModule } from "../kernel/accounting-kernel.module";
import { PostingCommandService } from "./posting-command.service";

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
  imports: [AccountingKernelModule],
  providers: [PostingCommandService],
  exports: [PostingCommandService],
})
export class AccountingAdaptersModule {}
