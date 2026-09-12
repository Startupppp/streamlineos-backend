import { Module } from "@nestjs/common";
import { SequenceReplyExitService } from "./sequence-reply-exit.service";

/**
 * A leaf, and it has to be one.
 *
 * `AutonomyService` injects `SequenceReplyExitService` so that a reply arriving
 * through the ingress seam ends the sequences aimed at that customer. That makes
 * `AutonomyModule` depend on this module — so this module may depend on nothing
 * inside `AutonomyModule`, or Nest refuses the graph at boot with a circular
 * dependency.
 *
 * Which is why the service takes only a database handle and why the rest of the
 * engine — `NurtureSequencesService`, the workflow, the controller — lives in
 * `AutonomySequencesModule` instead. That one imports `AutonomyModule` for
 * `OutboundService`, and the cycle stays open because nothing here reaches back.
 * Splitting the two is not tidiness; merging them does not compile.
 */
@Module({
  providers: [SequenceReplyExitService],
  exports: [SequenceReplyExitService],
})
export class SequenceReplyExitModule {}
