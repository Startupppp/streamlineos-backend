import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { RelationshipStateService } from "../relationships/relationship-state.service";
import { OutboundService } from "../autonomy/outbound.service";
import { AutonomyRepairService } from "../autonomy/autonomy-repair.service";
import { NUDGE_AFTER_DAYS } from "../autonomy/outbound-eligibility";
import { MAX_REPAIRS_PER_DECISION } from "../autonomy/dto/autonomy-review.schemas";

const DAY_MS = 86_400_000;

/**
 * How many quiet relationships one organisation is asked about per tick.
 *
 * Every candidate that turns out to be due costs a provider call, so this is a
 * bill as much as a page size — the same reasoning the renewal sweep uses, and
 * deliberately the same order of magnitude. `listAwaitingReply` orders oldest
 * first, so a truncated pass leaves behind the relationships that have been
 * quiet for the least time.
 */
const PER_ORG_CANDIDATES = 50;

/**
 * The two remaining CRM autonomy loops, on the schedule the platform already has.
 *
 * Neither is new machinery. `listAwaitingReply` says in its own docstring that it
 * is "the read ticket 02's detector runs", and its `olderThan` is a parameter
 * precisely so a sweep could own the clock — but no sweep was ever written, so
 * the detector had no caller and the silence loop existed only as two halves that
 * had never been introduced. `AutonomyRepairService.runRepairs` was reachable
 * only by POSTing to it.
 *
 * As with the renewal sweep, this decides which organisations to ask and how many
 * candidates to consider, and nothing else. Whether a quiet relationship deserves
 * a message is `judgeOutbound`'s, inside `composeAndHold`; whether a value may be
 * repaired is `repair-classes.ts`'s. Duplicating either judgement here would give
 * the product two answers to the same question.
 */
@Injectable()
export class CronCrmAutonomyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly relationships: RelationshipStateService,
    private readonly outbound: OutboundService,
    private readonly repairs: AutonomyRepairService,
  ) {}

  /**
   * Deals and relationships that have gone quiet, handed to the outbound loop.
   *
   * The cutoff is `NUDGE_AFTER_DAYS`, imported rather than restated: it is the
   * shorter of the two thresholds `judgeOutbound` applies, so it is the earliest
   * anything can be due. Everything this hands over is then judged properly —
   * a relationship with no open deal needs 45 days, not 10, and `composeAndHold`
   * refuses the ones that are not ready without this sweep needing to know why.
   *
   * A relationship anchored to a deal rather than a party is skipped:
   * `composeAndHold` addresses a party, and there is nobody to write to without
   * one.
   */
  async sweepSilentRelationships(): Promise<{
    organizations: number;
    failed: number;
    considered: number;
    held: number;
    refused: number;
  }> {
    const cutoff = new Date(Date.now() - NUDGE_AFTER_DAYS * DAY_MS);
    let considered = 0;
    let held = 0;
    let refused = 0;

    const result = await forEachOrg(this.db, "crm-silence-sweep", async (_tx, orgId) => {
      const quiet = await this.relationships.listAwaitingReply(orgId, cutoff, PER_ORG_CANDIDATES);

      for (const relationship of quiet) {
        const partyId = relationship.anchor.kind === "party" ? relationship.anchor.partyId : null;
        if (!partyId) continue;

        considered += 1;
        /**
         * No `dealId`: a party-anchored relationship does not carry one, and
         * `loadComposeContext` finds the party's open deal itself. Passing a
         * guess would narrow what it looks at rather than help it.
         */
        const outcome = await this.outbound.composeAndHold({
          organizationId: orgId,
          partyId,
        });

        if (outcome.held) held += 1;
        else refused += 1;
      }
    });

    return { organizations: result.succeeded, failed: result.failed, considered, held, refused };
  }

  /**
   * The deterministic field repairs a tenant has already agreed to.
   *
   * No model and no hold window: `repair-classes.ts` is the whole authority, every
   * class is a pure function over the value, and each one is still asked
   * separately whether this tenant allows it. `runRepairs` with no `classes`
   * considers them all, which is what an unattended pass should do — the tenant's
   * policy, not the scheduler's argument list, decides what actually happens.
   */
  async runFieldRepairs(): Promise<{
    organizations: number;
    failed: number;
    repaired: number;
    leftForAPerson: number;
  }> {
    let repaired = 0;
    let leftForAPerson = 0;

    const result = await forEachOrg(this.db, "crm-field-repairs", async (_tx, orgId) => {
      /**
       * `limit` is passed explicitly. It has a default, but that default lives
       * on the Zod schema and only applies to requests that came through the
       * route — calling the service directly with `{}` hands `runOneClass` an
       * undefined LIMIT.
       */
      const outcome = await this.repairs.runRepairs(orgId, {
        limit: MAX_REPAIRS_PER_DECISION,
      });
      repaired += outcome.repaired;
      leftForAPerson += outcome.leftForAPerson;
    });

    return { organizations: result.succeeded, failed: result.failed, repaired, leftForAPerson };
  }
}
