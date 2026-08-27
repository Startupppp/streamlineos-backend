import { Module } from "@nestjs/common";
import { CustomerLifecycleController } from "./customer-lifecycle.controller";
import { CustomerLifecycleService } from "./customer-lifecycle.service";
import { RenewalTriggerService } from "./renewal-trigger.service";

/**
 * What happens to a customer after the deal is won.
 *
 * One record type, one health computation and one trigger sweep — and no
 * outreach, no schedule and no hold, because ticket 09's whole position is that
 * the autonomy model the platform already has is the only one it gets. A renewal
 * trigger opens an opportunity; the existing outbound loop works it under every
 * existing guardrail.
 *
 * No imports. It reaches `deal_stage_transitions` and `autonomous_decisions`
 * through their tables and their pure builders (`toTransitionRow`,
 * `buildDecision`) rather than through the modules that own them, which keeps
 * the ledgers identical without adding two edges `madge --circular` would have
 * to keep acyclic.
 *
 * `CustomerLifecycleService` is exported because the health service in
 * `customer-executive` shares its rules — the same reason there is one health
 * computation on the platform rather than two that can disagree.
 */
@Module({
  controllers: [CustomerLifecycleController],
  providers: [CustomerLifecycleService, RenewalTriggerService],
  exports: [CustomerLifecycleService, RenewalTriggerService],
})
export class CustomerLifecycleModule {}
