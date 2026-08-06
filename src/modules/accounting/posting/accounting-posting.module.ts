import { Module } from "@nestjs/common";
import { NotificationsModule } from "../../notifications/notifications.module";
import { JournalPostingService } from "./journal-posting.service";
import { FinancePostingService } from "./finance-posting.service";

@Module({
  imports: [NotificationsModule],
  providers: [JournalPostingService, FinancePostingService],
  exports: [JournalPostingService, FinancePostingService],
})
export class AccountingPostingModule {}
