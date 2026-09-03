import { Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { candidateApplications, candidates } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { AutomationService } from "../../automation/automation.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { RecruitmentHandoffService } from "./recruitment-handoff.service";

/**
 * Everything an offer status change causes OUTSIDE the offer row: the tenant's automation
 * rules, and the HR handoff that turns an accepted offer into employment records.
 *
 * This is the file that changes when the automation event payloads or the handoff contract
 * change — a cadence set by other modules, not by the offer's own CRUD — and it is the only
 * part of the offer surface that needs `AutomationService` and `RecruitmentHandoffService`
 * at all. Keeping it here means the offer write path reads as writes, and the side effects
 * read as side effects.
 */

export interface OfferEffectDeps {
  db: Db;
  automation: AutomationService;
  handoff: RecruitmentHandoffService;
}

export type DispatchedOfferStatus = "SENT" | "ACCEPTED" | "DECLINED";

export interface DispatchedOfferTerms {
  offeredSalary: string | null;
  joiningDate: string | null;
  validUntil: string | null;
}

/**
 * Runs an offer side effect after the request transaction commits, and reports it when it
 * fails.
 *
 * The dispatch was a discarded promise with a rejection handler that returned undefined, and
 * `handleOfferAccepted` — which creates the employment records an accepted offer turns into —
 * was a second one nested inside it. An accepted offer whose handoff threw therefore left no
 * employee record and no trace that anything had gone wrong; the candidate showed as hired
 * and nothing downstream existed. The handoff is now awaited inside the dispatch so its
 * failure reaches this reporter, and the whole thing is deferred through
 * `registerAfterCommit` so it runs in its own tenant transaction after the offer row commits
 * (CLAUDE.md §4) rather than on a handle whose tenant GUC is about to be gone.
 */
export function deferOfferEffect(
  logger: Logger,
  label: string,
  orgId: string,
  work: () => Promise<unknown>,
): void {
  if (registerAfterCommit(work)) return;
  void work().catch((error: unknown) => {
    logger.error(
      `${label} failed for org ${orgId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  });
}

export async function dispatchOfferAutomation(
  deps: OfferEffectDeps,
  orgId: string,
  candidateId: number,
  offerId: number,
  newStatus: DispatchedOfferStatus,
  previousStatus: string,
  offer: DispatchedOfferTerms,
): Promise<void> {
  const { db, automation, handoff } = deps;

  const [candidate, latestApp] = await Promise.all([
    db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { firstName: true, lastName: true, email: true },
    }),
    db.query.candidateApplications.findFirst({
      where: eq(candidateApplications.candidateId, candidateId),
      with: { jobPosting: { columns: { title: true } } },
      orderBy: (t, { desc: d }) => [d(t.appliedAt)],
    }),
  ]);

  const candidateName = candidate ? `${candidate.firstName} ${candidate.lastName}` : "";
  const candidateEmail = candidate?.email ?? "";
  const jobTitle = latestApp?.jobPosting?.title ?? "";
  const respondedAt = new Date().toISOString();

  if (newStatus === "SENT") {
    if (previousStatus === "SENT") return;
    await automation.runAutomationsForEvent(orgId, "offer.sent", {
      offerId,
      candidateId,
      candidateName,
      candidateEmail,
      jobTitle,
      offeredSalary: offer.offeredSalary ?? "",
      joiningDate: offer.joiningDate ?? null,
      validUntil: offer.validUntil ?? null,
      sentAt: respondedAt,
    });
    return;
  }

  if (newStatus === "ACCEPTED") {
    await automation.runAutomationsForEvent(orgId, "offer.accepted", {
      offerId,
      candidateId,
      candidateName,
      candidateEmail,
      jobTitle,
      decision: "ACCEPTED",
      respondedAt,
    });
    await handoff.handleOfferAccepted(orgId, candidateId, offerId);
    return;
  }

  await automation.runAutomationsForEvent(orgId, "offer.rejected", {
    offerId,
    candidateId,
    candidateName,
    candidateEmail,
    jobTitle,
    decision: "REJECTED",
    respondedAt,
  });
}
