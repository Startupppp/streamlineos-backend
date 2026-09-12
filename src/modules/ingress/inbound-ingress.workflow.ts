import { Inject, Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { inboundEvents } from "../../db/schema";
import { WorkflowRegistry } from "../../common/workflow";
import type { StepContext, WorkflowRunContext } from "../../common/workflow";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { getRegionRegistry, hasRegionRegistry } from "../../common/region/region-registry";
import { AutonomyService } from "../autonomy/autonomy.service";
import { RelationshipSignalsService } from "../autonomy/relationship-signals.service";
import { RelationshipStateService } from "../relationships/relationship-state.service";
import { AutonomyScoringService } from "../autonomy/autonomy-scoring.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { INBOUND_WORKFLOW } from "./inbound-ingress.service";
import type { InboundCommunicationEvent } from "./inbound-event";
import { resolveInboundParty, type IngressStepDeps } from "./lib/ingress-resolve-party";
import {
  logInboundActivity,
  markInboundProcessed,
  recordInboundParticipants,
  shadowScoreInbound,
} from "./lib/ingress-filing";
import { inboundEventSchema } from "./dto/inbound-event.schemas";

/**
 * What happens after a communication arrives.
 *
 * Written as a durable workflow rather than a request handler because every step
 * has an external consequence and the whole thing has to survive a deploy, a
 * provider timeout and a database blip without repeating the half it already
 * did. Each `step.run` records its result, so a retry resumes rather than
 * re-creates — which is what stops a retried delivery from producing a second
 * party for the same sender.
 */
@Injectable()
export class InboundIngressWorkflow implements OnModuleInit {
  private readonly logger = new Logger("InboundIngress");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: WorkflowRegistry,
    /**
     * Optional so the seam stands on its own.
     *
     * Ticket 10's whole point is that a communication is filed correctly with no
     * human involved; whether the system then reasons about it is ticket 12's
     * concern, and the ingress path must not stop working if that is unwired.
     */
    @Optional() private readonly autonomy?: AutonomyService,
    /** Optional for the same reason as `autonomy`: measurement must not gate filing. */
    @Optional() private readonly scoring?: AutonomyScoringService,
    /**
     * Optional, but the absence is a decision rather than a default.
     *
     * Unwired, this workflow creates parties without consulting a plan, which is
     * the gap ticket 07 exists to close. It is optional only so the seam's own
     * tests can stand it up without a billing module behind them; every
     * composition that serves a tenant provides it, and
     * `party/party-creation-invariant.spec.ts` is what stops a future party
     * insert going in without asking the same question.
     */
    @Optional() private readonly planLimits?: PlanLimitsService,
    /**
     * Optional for the same reason. Ticket 01's model of
     * what normal looks like is derived from the activities, so a state that
     * failed to update is repaired by the next message on the relationship or by
     * an explicit rebuild — while a delivery rejected because a summary could not
     * be written is a customer's message the CRM never filed.
     */
    @Optional() private readonly relationships?: RelationshipStateService,
    /**
     * Optional for the same reason `autonomy` is: ticket 03's judgement must
     * not gate filing either. Reached through `AutonomyModule`, already
     * imported here for `AutonomyService` — no new module edge.
     */
    @Optional() private readonly relationshipSignals?: RelationshipSignalsService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: INBOUND_WORKFLOW,
      maxAttempts: 5,
      handler: (step, context) => this.handle(step, context),
    });
  }

  /**
   * What the step bodies in `lib/` act through. The step names, their order and
   * the reasons for each stay here in `handle`; see `lib/ingress-resolve-party.ts`
   * and `lib/ingress-filing.ts` for the bodies.
   */
  private stepDeps(): IngressStepDeps {
    return { db: this.db, logger: this.logger, planLimits: this.planLimits, scoring: this.scoring };
  }

  private async handle(step: StepContext, context: WorkflowRunContext): Promise<void> {
    const inboundEventId = String(context.input.inboundEventId ?? "");
    if (!inboundEventId) throw new Error("inbound: run started without an inboundEventId");

    /**
     * Read outside a step, deliberately — but inside a tenant transaction.
     *
     * The runtime's rule is that anything with an effect belongs in a step; a
     * read has none, so re-reading on each attempt is both correct and cheaper
     * than memoising a whole payload into the step log. It also means a retry
     * sees the current receipt rather than a snapshot of it.
     *
     * The transaction is not optional, though, and it is the half that was
     * missing. Only a `step.run` body gets an ambient tenant context, so a read
     * in the workflow body falls through the tenant-aware proxy to the raw pool
     * with no `app.organization_id` set. `inbound_events.organization_id` is NOT
     * NULL, so its policy still calls `app.current_org_id()`, which raises
     * 42501 with no GUC — invisible in dev, where `DATABASE_URL` connects as an
     * owner with BYPASSRLS, and five failed attempts and a dead-lettered
     * delivery in production.
     */
    const event = await runInNewTenantTransaction(this.db, context.organizationId, () =>
      this.loadEvent(context.organizationId, inboundEventId),
    );

    /**
     * Resolve the placement before touching tenant data.
     *
     * Every tenant transaction runs against the organisation's own region, and a
     * background continuation has no ambient request to inherit it from — so it
     * is resolved explicitly and recorded, which also makes it visible in the
     * run's steps when a delivery lands in the wrong place.
     */
    await step.run("resolve-region", async () => {
      if (!hasRegionRegistry()) return { region: "primary" };
      const region = await getRegionRegistry().regionForOrg(context.organizationId);
      return { region: region ?? "primary" };
    });

    const party = await step.run("resolve-party", () =>
      resolveInboundParty(this.stepDeps(), context, inboundEventId, event),
    );

    const activity = await step.run("log-activity", () =>
      logInboundActivity(this.stepDeps(), context, inboundEventId, event, party),
    );

    await step.run("record-participants", () =>
      recordInboundParticipants(this.stepDeps(), context, event, party, activity),
    );

    /**
     * What normal looks like for this relationship, brought up to date.
     *
     * Before extraction rather than after, because ticket 02's silence
     * judgement and ticket 03's participant judgement both read this row, and a
     * detector reasoning about a state that predates the message it was woken by
     * would be answering last week's question.
     *
     * Its own step for the ordinary reason every step here has its own: a retry
     * re-materialises without creating a second party and a second activity
     * first. It cannot throw the run down — a relationship summary is not worth
     * a dead-lettered delivery — but the failure is logged rather than swallowed.
     */
    await step.run("materialise-relationship", async () => {
      if (!this.relationships) return null;
      const delta = await this.relationships.tryOnActivity(context.organizationId, activity.activityId);
      /*
       * Ticket 03's judgement, folded into this same step rather than a step
       * of its own: `step.run` memoizes a completed step, so a retry replays
       * this result instead of re-running it — exactly what stops a retried
       * delivery from writing the same decision twice. A second step would
       * re-run on every retry that reached it, since its own memo would be
       * fresh each time this one already was not.
       */
      if (delta && this.relationshipSignals) {
        await this.relationshipSignals.evaluate(
          context.organizationId,
          activity.activityId,
          delta.before,
          delta.after,
        );
      }
      return null;
    });

    /**
     * The autonomous half, as its own step.
     *
     * Separate from logging the activity on purpose: extraction calls a provider
     * and a provider is the thing most likely to fail here. Its own step means a
     * retry re-runs the inference without creating a second party and a second
     * activity first — and a permanent extraction failure still leaves the
     * communication filed correctly, which is the half that must never be lost.
     */
    await step.run("extract-and-act", async () => {
      if (!this.autonomy) return null;
      await this.autonomy.processActivity(context.organizationId, activity.activityId);
      return null;
    });

    /**
     * The second opinion, as its own step again.
     *
     * After the decisions exist, never alongside them. Scoring is another
     * provider call, and putting it inside `extract-and-act` would mean a
     * scorer outage retried the extraction — spending twice and risking a
     * second set of writes to undo the first ones.
     *
     * It never throws outward. A decision that went unscored is a gap in a
     * measurement; a workflow that fails because the measurement failed would
     * be a gap in the product.
     */
    await step.run("shadow-score", () => shadowScoreInbound(this.stepDeps(), context, activity));

    await step.run("mark-processed", () =>
      markInboundProcessed(this.stepDeps(), context, inboundEventId, party, activity),
    );

    this.logger.log(
      `inbound ${event.channel} processed — party ${party.created ? "created" : "matched"}`,
    );
  }

  /**
   * The receipt, scoped to the organisation the run belongs to.
   *
   * The tenant predicate is stated rather than left to RLS: the run's
   * organisation is the authority on what this run may read, and a receipt id
   * that does not belong to it is "not found" here rather than at the policy.
   */
  private async loadEvent(
    organizationId: string,
    inboundEventId: string,
  ): Promise<InboundCommunicationEvent> {
    const [row] = await this.db
      .select({ payload: inboundEvents.payload })
      .from(inboundEvents)
      .where(
        and(
          eq(inboundEvents.organizationId, organizationId),
          eq(inboundEvents.inboundEventId, inboundEventId),
        ),
      )
      .limit(1);

    if (!row) throw new Error(`inbound: receipt ${inboundEventId} not found`);

    /**
     * Parsed, not cast.
     *
     * `payload` is `jsonb`, and this is the read half of a round-trip whose write half is
     * `inbound-ingress.service.ts`. A cast over a stored shape cannot fail: a row written
     * by an earlier release deserialises into a LIE rather than an error, and everything
     * below this line — the sender, the identifier kind, the participants filed against a
     * party — is then computed from fields that may not be there. The lesson is one file
     * away, at `adapters/mail-to-inbound-event.ts`: "a message somebody marked private is
     * filed into the CRM with nobody the wiser — which is exactly what a `as unknown as`
     * cast over a provider type that has no labels at all used to do here."
     *
     * `inboundEventSchema` is the same contract the HTTP boundary already enforces on the
     * write (`inbound-ingress.controller.ts:29`), so the two halves now agree instead of
     * one asserting what the other never checked.
     *
     * A mismatch RAISES. `loadEvent` runs inside a durable workflow, so the run retries
     * and then dead-letters carrying the reason, which is something an operator can see
     * and act on — where filing the communication on a guess is not. Only the issue paths
     * and codes are reported: a Zod issue can echo the offending value, and a participant
     * address is personal data that does not belong in a log line.
     */
    const parsed = inboundEventSchema.safeParse(row.payload);
    if (!parsed.success) {
      const where = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`)
        .join(", ");
      throw new Error(
        `inbound: receipt ${inboundEventId} payload does not match the inbound-event contract (${where})`,
      );
    }
    return parsed.data;
  }
}
