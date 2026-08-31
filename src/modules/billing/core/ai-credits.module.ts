import { Module } from "@nestjs/common";
import { AiCreditsService } from "./ai-credits.service";
import { AiCreditsReservationService } from "./ai-credits-reservation.service";
import { AiCreditsPacksService } from "./ai-credits-packs.service";

@Module({
  providers: [AiCreditsService, AiCreditsReservationService, AiCreditsPacksService],
  exports: [AiCreditsService, AiCreditsReservationService, AiCreditsPacksService],
})
export class AiCreditsModule {}
