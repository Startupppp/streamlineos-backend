import { Module } from "@nestjs/common";
import { CrmAutomationStudioModule } from "../crm-automation-studio/crm-automation-studio.module";
import { QuotesController } from "./quotes.controller";
import { QuotesService } from "./quotes.service";

@Module({ imports: [CrmAutomationStudioModule], controllers: [QuotesController], providers: [QuotesService] })
export class QuotesModule {}
