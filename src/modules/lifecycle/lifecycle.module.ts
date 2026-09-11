import { Module } from "@nestjs/common";
import { LifecycleController } from "./lifecycle.controller";
import { LifecycleService } from "./lifecycle.service";
import { CustomerHealthController } from "./customer-health.controller";
import { CustomerHealthService } from "./customer-health.service";

/**
 * What happens to a customer after the deal is won.
 *
 * It imports nothing. That is deliberate and it is what makes the dependency run
 * the right way: `DealsModule` imports this one so a won deal can open a term,
 * and if this module imported `DealsModule` back the pair would be a cycle Nest
 * could only resolve with `forwardRef` — the shape that has already cost this
 * codebase a build once (see `deal-party-projection.ts`).
 *
 * It reads Party through `party-legacy-seam`, which is a set of free functions
 * taking a `Db` rather than an injected service, so anchoring a contract to a
 * customer costs no module edge at all.
 *
 * `LifecycleService` is exported because the only thing that may open a
 * lifecycle is the closed-won transition, and that lives in `DealsService`.
 *
 * `CustomerHealthService` lives here rather than in a module of its own because
 * it shares this one's anchor and one of its sources: health is scored per
 * Party, and its usage input is read from the lifecycle signal history. A
 * separate module would have to import this one to reach those signals and
 * would buy nothing for the edge. It is exported for the same reason the
 * lifecycle service is -- a later sweep or digest that wants to refresh a
 * customer's score should call it rather than re-deriving the weights.
 */
@Module({
  controllers: [LifecycleController, CustomerHealthController],
  providers: [LifecycleService, CustomerHealthService],
  exports: [LifecycleService, CustomerHealthService],
})
export class LifecycleModule {}
