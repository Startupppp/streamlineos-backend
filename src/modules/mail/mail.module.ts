import { forwardRef, Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/core/integrations.module";
import { AiModule } from "../ai/core/ai.module";
import { MailController } from "./mail.controller";
import { MailService } from "./mail.service";
import { MailAccountsService } from "./mail-accounts.service";
import { MailAiService } from "./mail-ai.service";
import { GmailMailProvider } from "./providers/gmail-mail.provider";
import { OutlookMailProvider } from "./providers/outlook-mail.provider";

@Module({
  imports: [IntegrationsModule, forwardRef(() => AiModule)],
  controllers: [MailController],
  providers: [MailService, MailAccountsService, MailAiService, GmailMailProvider, OutlookMailProvider],
  exports: [MailService, MailAccountsService, MailAiService],
})
export class MailModule {}
