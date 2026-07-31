import { Module } from "@nestjs/common";
import { AiConfirmationService } from "./ai-confirmation.service";

@Module({
  providers: [AiConfirmationService],
  exports: [AiConfirmationService],
})
export class AiConfirmationModule {}