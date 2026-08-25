import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { activities, businessParties, dataQualityFindings, partyDuplicateCandidates } from "../../db/schema";
import type {
  DataQualityProducer,
  FindingSeverity,
  ProposedAction,
} from "../../db/schema/crm/data-quality";
import { orderPair } from "../party/party-merge-plan";
import { EmailSuppressionService } from "../email/email-suppression.service";
import { ACTION_REVERSIBILITY } from "./finding-vocabulary";
import { DataQualityHealthService } from "./dataset-health.service";
import {
  duplicateGroupKey,
  duplicateSeverity,
  stalenessBand,
  stalenessGroupKey,
} from "./producer-bands";
import { assessReachability } from "./field-checks";
import { SWEEPABLE_PRODUCERS, type ScanInput } from "./dto/data-quality.schemas";

/**
 * How many records one producer looks at in a single sweep.
 *
 * A bounded pass, not a guarantee of completeness. An unbounded sweep over
 * `business_parties` is a full-table scan a tenant can trigger from a button,
 * and the queue is worth having even when it is filled a slice at a time —
 * whereas a sweep that times out fills nothing at all.
 */
const SWEEP_CAP = 2000;

/** Rows per insert statement. Twenty columns, so this stays well inside the parameter limit. */
const INSERT_CHUNK = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

interface FindingDraft {
  readonly producer: DataQualityProducer;
  readonly findingKind: string;
  readonly subjectKey: string;
  readonly groupKey: string;
  readonly severity: FindingSeverity;
  readonly partyId: string;
  readonly relatedPartyId?: string | null;
  readonly evidence: Record<string, unknown>;
  readonly score?: number | null;
  readonly proposedAction: ProposedAction;
}

/**
 * Everything that files work into the queue.
 *
 * One rule binds every producer, and the grouped view depends on it: **`groupKey`
 * determines `severity`, `proposedAction` and `reversibility`**. That is why the
 * score band and the staleness band are inside the key rather than beside it. It
 * is what lets "412 findings, one decision" be a single `GROUP BY` row instead of
 * three rows asking a person the same question at three severities.
 *
 * The duplicate producer deliberately owns no scorer of its own. It reads what
 * `PartyRolesService.detectFor` already wrote through `assessDuplicate`; a second
 * scorer here would be two implementations of "are these the same company" that
 * disagree the first time either is tuned.
 */
@Injectable()
export class DataQualityProducersService {
  private readonly logger = new Logger("DataQualityProducers");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly suppressions: EmailSuppressionService,
    private readonly health: DataQualityHealthService,
  ) {}

  async sweep(organizationId: string, input: ScanInput) {
    const requested = new Set<string>(input.producers ?? SWEEPABLE_PRODUCERS);
    const drafts: FindingDraft[] = [];

    /**
     * The duplicate detector answers for two producers at once, because its
     * blockers *are* the contradiction check: a pair that shares a phone line
     * and disagrees about its tax number is one record contradicting another,
     * and re-deriving that from the raw columns would be the second scorer this
     * module refuses to own.
     */
    if (requested.has("duplicate") || requested.has("contradiction"))
      drafts.push(
        ...(await this.fromDuplicateCandidates(organizationId)).filter((draft) =>
          requested.has(draft.producer),
        ),
      );

    if (requested.has("reachability")) drafts.push(...(await this.reachability(organizationId)));
    if (requested.has("staleness"))
      drafts.push(...(await this.staleness(organizationId, input.staleAfterDays)));

    const filed = await this.file(organizationId, drafts);

    /**
     * The other direction. A sweep is the only thing that makes the number
     * worse, and recording only the resolutions would produce a trend that falls
     * forever regardless of what the dataset is actually doing.
     */
    await this.health.captureQuietly(organizationId);

    return {
      producers: [...requested].sort(),
      /**
       * What was looked at versus what was filed. A sweep that examined its cap
       * and found nothing and one that never got that far look identical
       * otherwise.
       */
      examined: drafts.length,
      filed,
      capped: drafts.length >= SWEEP_CAP,
    };
  }

  // ── Filing ────────────────────────────────────────────────────────────────

  /**
   * One insert per chunk, never one per finding.
   *
   * `ON CONFLICT` targets the partial unique over open findings, so a nightly
   * sweep refreshes what it already filed instead of duplicating it — and
   * crucially does **not** touch `first_detected_at` or the assignee. Age that
   * resets every night is not age, and a sweep that un-assigns somebody's work
   * would make the queue unusable within a day.
   */
  private async file(organizationId: string, drafts: readonly FindingDraft[]): Promise<number> {
    if (drafts.length === 0) return 0;

    const now = new Date();
    const rows = drafts.map((draft) => ({
      organizationId,
      producer: draft.producer,
      findingKind: draft.findingKind,
      subjectKey: draft.subjectKey,
      groupKey: draft.groupKey,
      severity: draft.severity,
      partyId: draft.partyId,
      relatedPartyId: draft.relatedPartyId ?? null,
      evidence: draft.evidence,
      score: draft.score ?? null,
      proposedAction: draft.proposedAction,
      /**
       * Taken from the action, never from the producer. Two producers proposing
       * the same action cannot then disagree about whether it can be undone.
       */
      reversibility: ACTION_REVERSIBILITY[draft.proposedAction],
      lastSeenAt: now,
    }));

    let filed = 0;
    for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
      const chunk = rows.slice(index, index + INSERT_CHUNK);
      const inserted = await this.db
        .insert(dataQualityFindings)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            dataQualityFindings.organizationId,
            dataQualityFindings.producer,
            dataQualityFindings.findingKind,
            dataQualityFindings.subjectKey,
          ],
          // Postgres infers a partial unique only when the predicate is repeated
          // here; without it this raises 42P10 rather than silently missing.
          targetWhere: sql`status = 'open'`,
          set: {
            lastSeenAt: now,
            severity: sql`excluded.severity`,
            groupKey: sql`excluded.group_key`,
            evidence: sql`excluded.evidence`,
            score: sql`excluded.score`,
            proposedAction: sql`excluded.proposed_action`,
            reversibility: sql`excluded.reversibility`,
          },
        })
        .returning({ findingId: dataQualityFindings.findingId });

      filed += inserted.length;
    }

    return filed;
  }

  // ── Duplicate, and its contradictions ─────────────────────────────────────

  private async fromDuplicateCandidates(organizationId: string): Promise<FindingDraft[]> {
    const candidates = await this.db
      .select()
      .from(partyDuplicateCandidates)
      .where(
        and(
          eq(partyDuplicateCandidates.organizationId, organizationId),
          eq(partyDuplicateCandidates.status, "PENDING"),
        ),
      )
      .orderBy(desc(partyDuplicateCandidates.score))
      .limit(SWEEP_CAP);

    return candidates.map((candidate) => {
      const { low, high } = orderPair(candidate.lowPartyId, candidate.highPartyId);
      const subjectKey = `${low}:${high}`;
      const blockers = candidate.blockers ?? [];
      const signals = candidate.signals ?? [];

      /**
       * A blocker is a contradiction, and a contradiction is not a merge waiting
       * for approval. `assessDuplicate` already refuses to merge on one; filing
       * it as a duplicate would put a merge button under a pair the scorer has
       * explicitly said must not be merged.
       */
      if (blockers.length > 0)
        return {
          producer: "contradiction" as const,
          findingKind: "contradiction.identity",
          subjectKey,
          groupKey: `contradiction:${blockers[0]}`,
          // Always high, so the group key determines the severity. Two records
          // claiming different registration numbers is an invoice going to the
          // wrong company, not housekeeping.
          severity: "high" as const,
          partyId: low,
          relatedPartyId: high,
          evidence: {
            candidateId: candidate.candidateId,
            score: candidate.score,
            signals,
            blockers,
            detectedAt: candidate.detectedAt,
          },
          score: candidate.score,
          proposedAction: "none" as const,
        };

      const severity = duplicateSeverity(candidate.score);

      return {
        producer: "duplicate" as const,
        findingKind: "duplicate.party-pair",
        subjectKey,
        /**
         * Signal and band both, because "these 60 pairs share a tax number and
         * score above the auto-merge bar" is a decision somebody can take in one
         * click, and "these 300 pairs have vaguely similar names" is emphatically
         * not the same decision.
         */
        groupKey: duplicateGroupKey(signals, severity),
        severity,
        partyId: low,
        relatedPartyId: high,
        evidence: {
          candidateId: candidate.candidateId,
          score: candidate.score,
          signals,
          detectedAt: candidate.detectedAt,
        },
        score: candidate.score,
        proposedAction: "merge-parties" as const,
      };
    });
  }

  // ── Reachability ──────────────────────────────────────────────────────────

  /**
   * Parties nothing can reach.
   *
   * Two sources, and both are real rather than inferred: the shape of the values
   * themselves, and `email_suppressions`, which the provider webhook fills with
   * hard bounces. A suppressed address is not a guess about deliverability — it
   * is the provider's own answer, already being enforced on every send.
   */
  private async reachability(organizationId: string): Promise<FindingDraft[]> {
    const parties = await this.db
      .select({
        partyId: businessParties.partyId,
        name: businessParties.name,
        email: businessParties.email,
        phone: businessParties.phone,
        whatsappPhone: businessParties.whatsappPhone,
      })
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          isNull(businessParties.deletedAt),
          eq(businessParties.status, "active"),
        ),
      )
      .orderBy(desc(businessParties.updatedAt))
      .limit(SWEEP_CAP);

    if (parties.length === 0) return [];

    const emails = parties
      .map((party) => party.email)
      .filter((email): email is string => typeof email === "string" && email.length > 0);

    /**
     * Through the email module's own service, not its table. It already knows
     * that a platform-wide row outranks a tenant one and that an expired
     * suppression does not count — three rules this module would otherwise have
     * to restate and eventually get wrong.
     */
    const suppressed =
      emails.length > 0 ? await this.suppressions.findSuppressed(emails, organizationId) : new Set<string>();

    const drafts: FindingDraft[] = [];

    for (const party of parties) {
      const email = party.email?.trim().toLowerCase() ?? "";

      if (email.length > 0 && suppressed.has(email)) {
        drafts.push({
          producer: "reachability",
          findingKind: "reachability.suppressed-email",
          subjectKey: `${party.partyId}:email`,
          groupKey: "reachability:suppressed-email",
          severity: "high",
          partyId: party.partyId,
          evidence: { email, reason: "the address is suppressed for delivery" },
          proposedAction: "none",
        });
      }

      for (const problem of assessReachability(party)) {
        drafts.push({
          producer: "reachability",
          findingKind: problem.kind,
          subjectKey: `${party.partyId}:${problem.kind}`,
          groupKey: problem.groupKey,
          severity: problem.severity,
          partyId: party.partyId,
          evidence: { detail: problem.detail, value: problem.value ?? null },
          proposedAction: "none",
        });
      }
    }

    return drafts;
  }

  // ── Staleness ─────────────────────────────────────────────────────────────

  /**
   * Records nobody has touched in long enough that their data is suspect.
   *
   * `updated_at` is the cheap pre-filter and the activity timeline is the real
   * test: a record edited last week is not stale whatever its timeline says, and
   * a record nobody has edited but somebody spoke to yesterday is not stale
   * either. Only when both are quiet is the data actually going off.
   */
  private async staleness(organizationId: string, staleAfterDays: number): Promise<FindingDraft[]> {
    const cutoff = new Date(Date.now() - staleAfterDays * DAY_MS);

    const lastActivityAt = sql<Date | null>`(
      SELECT max(${activities.occurredAt})
      FROM ${activities}
      WHERE ${activities.organizationId} = ${businessParties.organizationId}
        AND ${activities.partyId} = ${businessParties.partyId}
        AND ${activities.deletedAt} IS NULL
    )`;

    const rows = await this.db
      .select({
        partyId: businessParties.partyId,
        name: businessParties.name,
        lifecycleStage: businessParties.lifecycleStage,
        createdAt: businessParties.createdAt,
        updatedAt: businessParties.updatedAt,
        lastActivityAt,
      })
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          isNull(businessParties.deletedAt),
          eq(businessParties.status, "active"),
          /**
           * A lost relationship going quiet is the expected outcome, not a data
           * problem. Everything else — customers included — is in scope: a
           * customer nobody has spoken to in six months is exactly the finding
           * this producer exists for.
           */
          or(
            isNull(businessParties.lifecycleStage),
            ne(businessParties.lifecycleStage, "LOST"),
          ),
          // Cheap first, so the correlated activity lookup runs on a fraction of
          // the table rather than all of it.
          lt(businessParties.updatedAt, cutoff),
          lt(businessParties.createdAt, cutoff),
          sql`COALESCE(${lastActivityAt}, ${businessParties.createdAt}) < ${cutoff}`,
        ),
      )
      .orderBy(asc(businessParties.updatedAt))
      .limit(SWEEP_CAP);

    const now = Date.now();

    return rows.map((row) => {
      const lastTouched = row.lastActivityAt ?? row.createdAt;
      const quietDays = Math.max(0, Math.floor((now - lastTouched.getTime()) / DAY_MS));
      const { band, severity } = stalenessBand(quietDays, staleAfterDays);

      return {
        producer: "staleness" as const,
        findingKind: "staleness.no-contact",
        subjectKey: `${row.partyId}:no-contact`,
        /** The band is in the key so the group is one severity and one decision. */
        groupKey: stalenessGroupKey(band),
        severity,
        partyId: row.partyId,
        evidence: {
          quietDays,
          lastActivityAt: row.lastActivityAt,
          lifecycleStage: row.lifecycleStage,
          thresholdDays: staleAfterDays,
        },
        proposedAction: "none" as const,
      };
    });
  }
}
