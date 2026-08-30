import { Module } from "@nestjs/common";
import { NotificationsModule } from "../../notifications/notifications.module";
import { JournalPostingService } from "./journal-posting.service";
import { FinancePostingService } from "./finance-posting.service";
import { FinancePostingAccountsService } from "./finance-posting-accounts.service";

@Module({
  imports: [NotificationsModule],
  providers: [JournalPostingService, FinancePostingAccountsService, FinancePostingService],
  exports: [JournalPostingService, FinancePostingAccountsService, FinancePostingService],
})
export class AccountingPostingModule {}
