import { Module } from "@nestjs/common";
import { IssuesController } from "./issues.controller";
import { IssuesService } from "./issues.service";
import { IssueTransitionsService } from "./issue-transitions.service";

/**
 * Three record types, one module, no bespoke surfaces.
 *
 * `D27`: internal issues, internal tasks and customer complaints live in email
 * today, and the instinct is to build three modules for them. They differ in who
 * raises them and what a complaint is required to anchor to, and in nothing
 * else — so this module owns their shared shape and serves the renderer three
 * layout descriptions rather than shipping three sets of screens.
 *
 * It owns no accountability model. Stage moves go into a ledger that is
 * `deal_stage_transitions` column for column, because ticket 08 already solved
 * "record who moved this, and let that be a machine" and a second answer to that
 * question is worse than one imperfect one.
 *
 * No imports. `crm:issues:view` is scopable and the controller resolves that
 * scope through `AccessService`, which arrives from the `@Global` `AccessModule`
 * — importing it explicitly would add an edge to the graph that buys nothing and
 * that `madge --circular` would have to keep acyclic.
 */
@Module({
  controllers: [IssuesController],
  providers: [IssuesService, IssueTransitionsService],
})
export class IssuesModule {}
