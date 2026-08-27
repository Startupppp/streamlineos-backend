import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  activation,
  nextStep,
  STEP_PROMPTS,
  type Activation,
  type ActivationStep,
  type WorkspaceSignals,
} from "./activation";
import { DEMO_SOURCE } from "./demo-dataset";

export interface ActivationReport extends Activation {
  readonly signals: WorkspaceSignals;
  /** The one thing worth doing next, and what to say about it. */
  readonly next: { readonly step: ActivationStep; readonly prompt: string } | null;
}

/**
 * The counts behind the definition, read once -- and counting only what the
 * tenant put there.
 *
 * Every record signal excludes the demo dataset signup seeds (ticket 13). It has
 * to: the workspace ships with twelve parties and five deals in it, which is
 * more than the ten-record threshold below, so counting them would report every
 * workspace as having brought its data on the day it was created and make this
 * whole measure describe our seeding rather than their adoption.
 *
 * The exclusion belongs here, in the query, rather than as a subtraction
 * afterwards: a tenant who deletes half the samples and adds their own must end
 * up with an honest count, and arithmetic on totals cannot do that.
 *
 * `activation()` is pure and stays that way; this is the only thing that knows
 * where the numbers live. Splitting it here rather than inside the pure function
 * is what lets the definition of "activated" be argued with in a unit test
 * rather than against a database.
 *
 * One statement rather than six round trips, for the same reason
 * `plan-limits.service.ts` fetches its fourteen counts together: this is read on
 * a surface a person is waiting for, and six sequential counts on a cold
 * connection is a visible pause.
 */
@Injectable()
export class ActivationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async report(orgId: string): Promise<ActivationReport> {
    const signals = await this.signals(orgId);
    const step = nextStep(signals);

    return {
      ...activation(signals),
      signals,
      next: step ? { step, prompt: STEP_PROMPTS[step] } : null,
    };
  }

  private async signals(orgId: string): Promise<WorkspaceSignals> {
    const rows = await this.db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM business_parties
          WHERE organization_id = ${orgId} AND deleted_at IS NULL
            AND acquisition_source IS DISTINCT FROM ${DEMO_SOURCE}) AS real_parties,
        -- A demo deal has no marker of its own, because the deals table has no
        -- provenance column; it is recognised by the customer it is with. A deal
        -- the tenant opened against one of their own parties -- or against
        -- nobody, which is most of them -- is theirs and counts.
        (SELECT COUNT(*)::int FROM deals d
          WHERE d.org_id = ${orgId} AND d.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM business_parties p
               WHERE p.organization_id = d.org_id
                 AND p.party_id = d.party_id
                 AND p.acquisition_source = ${DEMO_SOURCE})) AS real_deals,
        (SELECT COUNT(*)::int FROM activities
          WHERE organization_id = ${orgId}
            AND source IS DISTINCT FROM ${DEMO_SOURCE}) AS real_activities,
        -- A member who accepted, not one who was invited. An invitation sent is
        -- the sender's action; this counts the tenant's own people who turned up.
        (SELECT COUNT(*)::int FROM organization_members
          WHERE org_id = ${orgId} AND activated_at IS NOT NULL AND left_at IS NULL)
          AS active_members,
        -- Committed, and not since reverted. An import that was undone did not
        -- leave the workspace with the tenant's data in it, which is the whole
        -- of what this signal is for.
        (SELECT EXISTS (SELECT 1 FROM crm_imports
          WHERE organization_id = ${orgId} AND status = 'committed')) AS has_import,
        -- A channel that actually delivered something. A connection configured
        -- and never used is a setting rather than a signal, and counting it
        -- would report first value that nobody has had.
        (SELECT EXISTS (SELECT 1 FROM inbound_events
          WHERE organization_id = ${orgId})) AS has_channel
    `);

    const row = rows[0] ?? {};

    return {
      realParties: Number(row["real_parties"] ?? 0),
      realDeals: Number(row["real_deals"] ?? 0),
      realActivities: Number(row["real_activities"] ?? 0),
      activeMembers: Number(row["active_members"] ?? 0),
      hasCompletedImport: row["has_import"] === true,
      hasConnectedChannel: row["has_channel"] === true,
    };
  }
}
