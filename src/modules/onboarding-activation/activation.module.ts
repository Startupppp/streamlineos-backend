import { Module } from "@nestjs/common";
import { ActivationController } from "./activation.controller";
import { ActivationService } from "./activation.service";

/**
 * First value, measured rather than declared.
 *
 * Its own module rather than a corner of onboarding, because "has this
 * workspace got going" is a question the whole product asks -- billing wants it
 * for trial conversion, the dashboard wants it for a progress surface -- and
 * putting it inside the signup flow would make it reachable only from there.
 */
@Module({
  controllers: [ActivationController],
  providers: [ActivationService],
  exports: [ActivationService],
})
export class ActivationModule {}
