import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { AccountingAiController } from "./accounting-ai.controller";
import { AccountingAiService } from "./accounting-ai.service";

@Module({
  imports: [AiModule],
  controllers: [AccountingAiController],
  providers: [AccountingAiService],
})
export class AccountingAiModule {}
