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
 * So the dependency runs the other way. This module sits downstream of both and
 * owns the trigger and nothing else; the renewal book stays where it was and the
 * outbound loop stays where it was. It is registered on `AppModule`, and imported
 * by `CronModule` alone — for the scheduled sweep below, which needs the service
 * and nothing else here.
 *
 * It exports `LifecycleTriggersService` so that whatever runs the sweep on a
 * timer calls it rather than growing its own copy of the decision. `CronModule`
 * now does exactly that, through `POST /cron/crm-lifecycle-triggers-sweep`.
 */
@Module({
  imports: [AutonomyModule, DealsModule],
  controllers: [LifecycleTriggersController],
  providers: [LifecycleTriggersService],
  exports: [LifecycleTriggersService],
})
export class LifecycleTriggersModule {}
