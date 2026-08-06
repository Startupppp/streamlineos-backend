import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/core/integrations.module";
import { AiGatewayModule } from "../ai/core/gateway/ai-gateway.module";
import { MailController } from "./mail.controller";
import { MailService } from "./mail.service";
import { MailAccountsService } from "./mail-accounts.service";
import { MailAiService } from "./mail-ai.service";
import { GmailMailProvider } from "./providers/gmail-mail.provider";
import { OutlookMailProvider } from "./providers/outlook-mail.provider";

@Module({
  imports: [IntegrationsModule, AiGatewayModule],
  controllers: [MailController],
  providers: [MailService, MailAccountsService, MailAiService, GmailMailProvider, OutlookMailProvider],
  exports: [MailService, MailAccountsService, MailAiService],
})
export class MailModule {}
