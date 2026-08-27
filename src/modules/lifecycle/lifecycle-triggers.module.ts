import { Module } from "@nestjs/common";
import { AutonomyModule } from "../autonomy/autonomy.module";
import { DealsModule } from "../deals/deals.module";
import { LifecycleTriggersController } from "./lifecycle-triggers.controller";
import { LifecycleTriggersService } from "./lifecycle-triggers.service";

/**
 * A module of its own, beside `LifecycleModule` rather than inside it.
 *
 * `LifecycleModule` imports nothing, and that is load-bearing: `DealsModule`
 * imports IT so a won deal can open a term. Adding `AutonomyModule` — which
 * imports `DealsModule`, which imports `LifecycleModule` — to the lifecycle
 * module would close a three-hop cycle Nest can only resolve with `forwardRef`,
 * the shape this codebase has already paid for once (see
 * `deal-party-projection.ts`).
 *
 * So the dependency runs the other way. This module sits downstream of both, is
 * imported by nothing, and is registered on `AppModule` alone. It owns the
 * trigger and nothing else; the renewal book stays where it was and the outbound
 * loop stays where it was.
 *
 * It exports `LifecycleTriggersService` so that whatever eventually runs the
 * sweep on a timer calls it rather than growing its own copy of the decision.
 * Nothing runs it on a timer today; see the note on the service.
 */
@Module({
  imports: [AutonomyModule, DealsModule],
  controllers: [LifecycleTriggersController],
  providers: [LifecycleTriggersService],
  exports: [LifecycleTriggersService],
})
export class LifecycleTriggersModule {}
