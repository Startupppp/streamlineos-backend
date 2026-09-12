import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { autonomousDecisions, deals } from "../../db/schema";
import type { RelationshipAnchor, StoredRelationship } from "../relationships/relationship-state.types";
import { DealsService } from "../deals/deals.service";
import { buildDecision, decisionDealId, shouldAct } from "./decision-record";
import { detectParticipantChange, detectThreadFork } from "./lib/relationship-signals";

/**
 * Phase 4 ticket 03, turning the two pure signals in
 * `lib/relationship-signals.ts` into what the ticket actually asks for: a
 * decision record with evidence and a reversibility class, gated by the same
 * `shouldAct` threshold every other autonomous decision answers to.
 *
 * Lives in `autonomy`, not in `relationships` — `relationships.module.ts` says
 * why it imports nothing: `activities` and `ingress` both depend on it, and
 * `autonomy` already depends on `deals` (needed below to open a second
 * opportunity), so putting this here instead keeps `relationships` a leaf and
 * the import graph acyclic. `InboundIngressWorkflow` already imports
 * `AutonomyModule` for `AutonomyService`; this is exported alongside it.
 */
@Injectable()
export class RelationshipSignalsService {
  private readonly logger = new Logger("RelationshipSignals");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dealsService: DealsService,
  ) {}

  /**
   * Called once per fold, with the state on both sides of it.
   *
   * Both signals are evaluated from the same before/after pair — they are
   * independent facts about the same fold, not a pipeline where one feeds the
   * other, so nothing here short-circuits on the first one firing.
   */
  async evaluate(
    organizationId: string,
    activityId: string,
    before: StoredRelationship | null,
    after: StoredRelationship | null,
  ): Promise<void> {
    await this.evaluateParticipantChange(organizationId, activityId, before, after);
    await this.evaluateThreadFork(organizationId, activityId, before, after);
  }

  private async evaluateParticipantChange(
    organizationId: string,
    activityId: string,
    before: StoredRelationship | null,
    after: StoredRelationship | null,
  ): Promise<void> {
    const signal = detectParticipantChange(before, after);
    if (!signal || !after) return;

    const act = shouldAct("participant.changed", signal.confidence);

    await this.record(
      buildDecision({
        organizationId,
        kind: "participant.changed",
        // "applied" here means recorded as a confident finding, not that
        // anything was written — this kind never writes. Below threshold it
        // is still worth keeping, as "skipped", so a reviewer can see the
        // model considered and declined a marginal case rather than nothing
        // having been looked at.
        outcome: act ? "applied" : "skipped",
        triggerType: "activity",
        triggerId: activityId,
        partyId: after.anchor.kind === "party" ? after.anchor.partyId : null,
        dealId: after.anchor.kind === "deal" ? decisionDealId(after.anchor.dealId) : null,
        activityId,
        confidence: signal.confidence,
        inputs: { relationshipStateId: after.relationshipStateId },
        decision: signal.evidence,
        summary: `${signal.droppedIdentity} has stopped replying; ${signal.risenIdentity} has started.`,
      }),
    );
  }

  private async evaluateThreadFork(
    organizationId: string,
    activityId: string,
    before: StoredRelationship | null,
    after: StoredRelationship | null,
  ): Promise<void> {
    const signal = detectThreadFork(before, after);
    if (!signal || !after) return;

    const act = shouldAct("thread.forked", signal.confidence);
    let outcome: "applied" | "skipped" | "failed" = "skipped";
    let createdDealId: number | null = null;
    let note: string | null = null;

    if (act) {
      const seed = await this.seedForFork(organizationId, after.anchor);
      if (!seed) {
        // Stated rather than silently guessed — see `seedForFork`. A fork on a
        // relationship with no prior deal is real and worth the record; it is
        // only the deal-creation half that has nothing to inherit an owner
        // from, so `field.repaired`-style invention of one is refused here
        // the same way the migration guards refuse to invent a party.
        note = "No existing deal on this relationship to inherit an owner or pipeline from.";
      } else {
        try {
          const created = await this.dealsService.createDeal(organizationId, "system", {
            name: signal.subject?.trim() || "New opportunity (forked thread)",
            assignedToId: seed.assignedToId,
            partyId: seed.partyId ?? undefined,
          });
          if (created) {
            createdDealId = created.id;
            outcome = "applied";
          } else {
            outcome = "failed";
            note = "createDeal returned nothing.";
          }
        } catch (error) {
          outcome = "failed";
          note = error instanceof Error ? error.message : String(error);
          this.logger.warn(`thread-fork deal creation failed: ${note}`, { organizationId, activityId });
        }
      }
    } else {
      note = `confidence ${signal.confidence} below threshold`;
    }

    await this.record(
      buildDecision({
        organizationId,
        kind: "thread.forked",
        outcome,
        triggerType: "activity",
        triggerId: activityId,
        partyId: after.anchor.kind === "party" ? after.anchor.partyId : null,
        dealId:
          createdDealId !== null
            ? decisionDealId(createdDealId)
            : after.anchor.kind === "deal"
              ? decisionDealId(after.anchor.dealId)
              : null,
        activityId,
        confidence: signal.confidence,
        inputs: { relationshipStateId: after.relationshipStateId },
        decision: { ...signal.evidence, createdDealId, note },
        summary:
          outcome === "applied"
            ? `Thread forked into a distinct subject ("${signal.subject ?? "untitled"}") — opened deal #${createdDealId}.`
            : `Thread forked into a distinct subject ("${signal.subject ?? "untitled"}")${note ? ` — ${note}` : ""}.`,
      }),
    );
  }

  /**
   * The owner and party to seed a forked-thread deal from.
   *
   * Never invents an assignee. `deals.assigned_to_id` is a real foreign key to
   * `users`, and the pattern elsewhere in this module for a system-driven
   * write (`userId = "system"`) only ever labels an actor on an UPDATE or an
   * audit row — it is not a real user, so writing it into this column would
   * 23503 on every single fork. Returns null when there is nothing safe to
   * inherit, which the caller treats as "record the signal, skip the deal"
   * rather than as a failure.
   */
  private async seedForFork(
    organizationId: string,
    anchor: RelationshipAnchor,
  ): Promise<{ assignedToId: string; partyId: string | null } | null> {
    const where =
      anchor.kind === "deal"
        ? and(eq(deals.orgId, organizationId), eq(deals.id, anchor.dealId), isNull(deals.deletedAt))
        : and(eq(deals.orgId, organizationId), eq(deals.partyId, anchor.partyId), isNull(deals.deletedAt));

    const [deal] = await this.db
      .select({ assignedToId: deals.assignedToId, partyId: deals.partyId })
      .from(deals)
      .where(where)
      .orderBy(desc(deals.createdAt))
      .limit(1);

    if (!deal?.assignedToId) return null;
    return { assignedToId: deal.assignedToId, partyId: deal.partyId ?? (anchor.kind === "party" ? anchor.partyId : null) };
  }

  private async record(row: ReturnType<typeof buildDecision>): Promise<void> {
    await this.db.insert(autonomousDecisions).values(row);
  }
}
