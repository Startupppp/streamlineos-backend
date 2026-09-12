import { Module } from "@nestjs/common";
import { AutonomyModule } from "../autonomy.module";
import { NurtureSequencesController } from "./nurture-sequences.controller";
import { NurtureSequencesService } from "./nurture-sequences.service";
import { NurtureStepSenderService } from "./nurture-step-sender.service";

/**
 * The rest of the nurture engine — the authoring surface and the sender.
 *
 * The direction of the arrow is the whole reason this is a second module rather
 * than more providers in `SequenceReplyExitModule`. `AutonomyService` injects
 * `SequenceReplyExitService`, so `AutonomyModule` already depends on that one
 * and it must stay a leaf. This module depends the other way — on
 * `AutonomyModule`, for `OutboundService` — and the graph only stays acyclic
 * while nothing in `AutonomyModule` reaches back here. Nest refuses a cycle at
 * boot, so the failure is loud; the point of saying it here is that the split is
 * load-bearing rather than tidy, and merging the two modules does not compile.
 *
 * `NurtureStepSenderService` is exported and no cron endpoint is registered.
 * The scheduler is `CronCrmAutonomyService`'s business — the silence sweep and
 * the repair pass already reach into autonomy the same way, and a second module
 * owning its own tick would put the platform's schedule in two places.
 */
@Module({
  imports: [AutonomyModule],
  controllers: [NurtureSequencesController],
  providers: [NurtureSequencesService, NurtureStepSenderService],
  exports: [NurtureSequencesService, NurtureStepSenderService],
})
export class AutonomySequencesModule {}
