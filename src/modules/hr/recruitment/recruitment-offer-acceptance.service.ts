import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { candidateOffers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AutomationService } from "../../automation/automation.service";
import { RecruitmentHandoffService } from "./recruitment-handoff.service";
import { RecruitmentOnboardingStartService } from "./recruitment-onboarding-start.service";
import {
  deferOfferEffect,
  dispatchOfferAutomation,
  type DispatchedOfferStatus,
  type DispatchedOfferTerms,
} from "./recruitment-offer-effects";
import { completeHire, type AcceptedOffer, type HireCompletion } from "./recruitment-hire-completion";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import type { OnboardingStartOutcome } from "./recruitment-onboarding-start.service";
import { orgOwnerUserId } from "../../../common/org/org-owner-actor";

/**
 * The one answer to "an offer's status just changed — what else happens".
 *
 * There were two accept paths and only one of them did anything. A recruiter
 * patching the offer internally ran the automation and the HR handoff; the
 * candidate clicking Accept on `/offer/:token` — the path candidates actually
 * use — set a column and returned. Both now route through here, so the
 * candidate-facing link and the internal button cause exactly the same thing.
 *
 * The split is by transaction, not by caller:
 *   `completeAcceptedOffer` runs INSIDE the caller's transaction, because the
 *   seat closing must commit with the acceptance or not at all.
 *   `deferStatusEffects` runs AFTER it commits, because the handoff, the
 *   automation rules and onboarding each need their own transaction and none of
 *   them may hold the request's connection open across a network call.
 */
/** The only statuses a candidate may still answer from. */
export const RESPONDABLE_STATUSES = ["SENT", "VIEWED"] as const;

@Injectable()
export class RecruitmentOfferAcceptanceService {
  private readonly logger = new Logger(RecruitmentOfferAcceptanceService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly automation: AutomationService,
    private readonly audit: AuditService,
    private readonly handoff: RecruitmentHandoffService,
    private readonly onboarding: RecruitmentOnboardingStartService,
  ) {}

  /**
   * Claims the acceptance, and returns null when somebody else already did.
   *
   * The conditional `WHERE offer_status IN ('SENT','VIEWED')` is the
   * serialisation point for two concurrent accepts: both transactions queue on
   * the row lock, the first flips the status, and the second matches no row and
   * gets null. Reading the status first and writing second — which is what both
   * paths did — lets both callers believe they were the one who accepted, and
   * the opening gets decremented twice.
   */
  async claimResponse(
    tx: Db,
    orgId: string,
    offerId: number,
    newStatus: "ACCEPTED" | "DECLINED" | "COUNTERED",
    extra: Partial<typeof candidateOffers.$inferInsert> = {},
  ): Promise<{ candidateId: number; jobPostingId: number | null } | null> {
    const now = new Date();
    const [claimed] = await tx
      .update(candidateOffers)
      .set({ offerStatus: newStatus, respondedAt: now, updatedAt: now, ...extra })
      .where(
        and(
          eq(candidateOffers.id, offerId),
          eq(candidateOffers.orgId, orgId),
          /**
           * The same set `respondToOffer` refuses on, asserted again here so
           * the refusal is a property of the write rather than of a read that
           * happened earlier.
           */
          inArray(candidateOffers.offerStatus, RESPONDABLE_STATUSES),
        ),
      )
      .returning({
        candidateId: candidateOffers.candidateId,
        jobPostingId: candidateOffers.jobPostingId,
      });
    return claimed ?? null;
  }

  /** The seat-closing writes, inside the caller's transaction. */
  async completeAcceptedOffer(tx: Db, orgId: string, offer: AcceptedOffer): Promise<HireCompletion> {
    return completeHire(tx, orgId, offer);
  }

  /**
   * Automation, the HR handoff and onboarding — after the offer row commits.
   *
   * Registered through `deferOfferEffect`, so a failure is reported rather than
   * swallowed, and so each hook gets its own tenant transaction.
   */
  deferStatusEffects(
    orgId: string,
    candidateId: number,
    offerId: number,
    newStatus: DispatchedOfferStatus,
    previousStatus: string,
    terms: DispatchedOfferTerms,
  ): void {
    deferOfferEffect(this.logger, "offer automation dispatch", orgId, async () => {
      await dispatchOfferAutomation(
        { db: this.db, automation: this.automation, handoff: this.handoff },
        orgId,
        candidateId,
        offerId,
        newStatus,
        previousStatus,
        terms,
      );
      /**
       * Onboarding is registered as an after-commit hook OF THIS HOOK, not
       * called from inside it.
       *
       * `handleOfferAccepted` above runs on this transaction, so the person and
       * the employment it creates are not visible to any other transaction
       * until this one commits — a fresh transaction opened here read no
       * employment and the start refused with
       * `no-employment-record-for-this-candidate`. Running it on THIS
       * transaction instead would see them, but would also make a refused
       * member seat roll the hire back. Deferring again resolves both: the
       * hire commits, then onboarding runs against committed rows in a
       * transaction of its own.
       */
      if (newStatus === "ACCEPTED") {
        const start = () => this.startOnboarding(orgId, candidateId, offerId);
        if (!registerAfterCommit(start))
          await runInNewTenantTransaction(this.db, orgId, start);
      }
    });
  }

  /**
   * Onboarding is attempted only after `handleOfferAccepted` has returned, so
   * the employment record it needs exists. The outcome is audited either way:
   * "onboarding started" is a claim, and a claim nobody can re-read is how the
   * recruiter ends up believing a checklist exists that does not.
   */
  private async startOnboarding(orgId: string, candidateId: number, offerId: number): Promise<void> {
    /**
     * Its own error boundary. The hire has already committed by the time this
     * runs, and onboarding failing — a full member seat, a refused email
     * domain — must not be reported as a failed hire or retried as one.
     */
    const outcome = await this.onboarding
      .startForCandidate(orgId, candidateId)
      .catch((error: unknown): OnboardingStartOutcome => ({
        started: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
    /**
     * `audit_logs.user_id` has an FK to `users.id`, so `"system"` here would be
     * refused and the one record explaining why a hire has no onboarding would
     * be the one that never lands — `AuditService.log` swallows its own
     * failures by design.
     */
    this.audit.log({
      action: outcome.started ? "HIRE_ONBOARDING_STARTED" : "HIRE_ONBOARDING_NOT_STARTED",
      userId: (await orgOwnerUserId(this.db, orgId)) ?? candidateId.toString(),
      orgId,
      targetId: String(candidateId),
      targetType: "candidate",
      metadata: { offerId, ...outcome },
    });
    if (!outcome.started)
      this.logger.warn(
        `offer ${offerId} accepted in org ${orgId} but onboarding did not start: ${outcome.reason}`,
      );
  }
}
