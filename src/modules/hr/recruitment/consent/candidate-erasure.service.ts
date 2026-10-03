import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { StorageService } from "../../../storage/storage.service";
import { HR_SCAN_MAX_PAGES, HR_SCAN_PAGE } from "../../hr-read-limits";
import {
  purgeRetiredObject,
  type PurgeOutcome,
} from "../../../cron/cron-hr-retention.service";
import {
  auditLogs,
  candidateApplications,
  candidateDocumentsVault,
  candidateSlaTracking,
  candidates,
  interviews,
} from "../../../../db/schema";
import {
  summariseVaultErasure,
  type ObjectErasureOutcome,
  type VaultErasureSummary,
} from "./candidate-vault-erasure";

/**
 * Whether the candidate can honestly be described as erased.
 *
 * Not a boolean, for the same reason the retention decision is not one: the
 * caller has to tell a real person what happened to their résumé, and "false"
 * does not distinguish "we deleted nothing" from "we deleted the records but an
 * object may survive in a bucket".
 */
export type CandidateErasureStatus = "ERASED" | "VAULT_NOT_CONFIRMED";

export interface CandidateErasureResult {
  candidateId: number;
  status: CandidateErasureStatus;
  /** Database rows actually removed, counted from what the delete returned. */
  recordsDeleted: {
    applications: number;
    interviews: number;
    slaTracking: number;
    vaultDocuments: number;
    candidate: number;
  };
  vault: VaultErasureSummary;
  /** The sentence a caller may repeat to the candidate, and no more than it. */
  summary: string;
}

/**
 * Erases a candidate's personal data, including the résumé vault.
 *
 * The reason this is its own service rather than a few more lines inside
 * `RecruitmentCandidatesService.remove` is the vault. `remove` deletes
 * candidate rows and returns `{ success: true }` unconditionally; it has never
 * touched `candidate_documents_vault`, so today deleting a candidate leaves
 * both the vault rows and the stored résumés behind while reporting success.
 * That report is the specific defect this file exists to fix — not the missing
 * delete, which is merely a bug, but the false confirmation, which is what
 * makes the bug invisible.
 *
 * What this service can and cannot guarantee is stated in the result rather
 * than assumed by the caller. See `eraseCandidate`.
 */
@Injectable()
export class CandidateErasureService {
  private readonly logger = new Logger(CandidateErasureService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  /**
   * Removes the candidate's records and attempts to delete every vault object.
   *
   * GUARANTEED on a successful return: the database rows counted in
   * `recordsDeleted` are gone, committed in one transaction.
   *
   * NOT guaranteed: that the stored objects are gone. The delete is a network
   * call to an object store this process does not own, and an S3-compatible
   * delete of a key that is absent answers success either way — so a delete
   * that appeared to work is not proof the object was there and is now not.
   * What IS known is whether the store accepted the call, and that is the
   * difference `status` reports. A `VAULT_NOT_CONFIRMED` result must never be
   * relayed to a candidate as "your data has been deleted".
   *
   * Every object is written to the pending-purge ledger BEFORE its delete is
   * attempted, so a failure leaves a row the storage sweep will retry rather
   * than an orphan nobody is pointing at. That ordering lives in
   * `purgeRetiredObject`, which is reused rather than reimplemented because a
   * dedicated spec pins the order there and a second copy would not be covered
   * by it.
   */
  async eraseCandidate(
    orgId: string,
    candidateId: number,
    actorUserId: string,
  ): Promise<CandidateErasureResult> {
    const existing = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });
    // A cross-tenant miss is a 404 rather than a 403: a 403 would confirm that
    // this candidate exists in somebody else's organisation.
    if (!existing) throw new NotFoundException("Candidate not found.");

    const vaultDocuments = [];
    let afterVaultId = 0;
    for (let page = 0; page < HR_SCAN_MAX_PAGES; page++) {
      const batch = await this.db
        .select({
          id: candidateDocumentsVault.id,
          s3Key: candidateDocumentsVault.s3Key,
        })
        .from(candidateDocumentsVault)
        .where(
          and(
            eq(candidateDocumentsVault.candidateId, candidateId),
            eq(candidateDocumentsVault.orgId, orgId),
            gt(candidateDocumentsVault.id, afterVaultId),
          ),
        )
        .orderBy(asc(candidateDocumentsVault.id))
        .limit(HR_SCAN_PAGE);
      vaultDocuments.push(...batch);
      if (batch.length < HR_SCAN_PAGE) break;
      afterVaultId = batch[batch.length - 1].id;
    }

    /*
      The storage deletes run BEFORE and OUTSIDE the transaction, deliberately.
      A network call inside the request transaction holds a pooled connection
      open through somebody else's outage, and an object store that is slow
      today would turn one erase request into a database incident.

      Running them first also means a total storage outage leaves the candidate
      row intact and the request reporting VAULT_NOT_CONFIRMED, rather than
      deleting every pointer to objects that are still there.
    */
    const outcomes: ObjectErasureOutcome[] = [];
    for (const document of vaultDocuments) {
      if (document.s3Key.trim().length === 0) continue;
      const outcome = await purgeRetiredObject(
        this.db,
        this.storage,
        orgId,
        document.s3Key,
        (message, meta) => this.logger.error(message, meta),
      );
      outcomes.push(toObjectOutcome(outcome));
    }
    const vault = summariseVaultErasure(outcomes);

    const recordsDeleted = await this.db.transaction(async (tx) => {
      const slaRows = await tx
        .delete(candidateSlaTracking)
        .where(
          and(
            eq(candidateSlaTracking.candidateId, candidateId),
            eq(candidateSlaTracking.orgId, orgId),
          ),
        )
        .returning({ id: candidateSlaTracking.id });

      const interviewRows = await tx
        .delete(interviews)
        .where(and(eq(interviews.candidateId, candidateId), eq(interviews.orgId, orgId)))
        .returning({ id: interviews.id });

      const applicationRows = await tx
        .delete(candidateApplications)
        .where(
          and(
            eq(candidateApplications.candidateId, candidateId),
            eq(candidateApplications.orgId, orgId),
          ),
        )
        .returning({ id: candidateApplications.id });

      const vaultRows = await tx
        .delete(candidateDocumentsVault)
        .where(
          and(
            eq(candidateDocumentsVault.candidateId, candidateId),
            eq(candidateDocumentsVault.orgId, orgId),
          ),
        )
        .returning({ id: candidateDocumentsVault.id });

      /*
        The audit row is written before the candidate row goes, and into
        `audit_logs` rather than `vault_access_logs`, because the latter
        cascades on candidate delete — an erasure record stored there would be
        destroyed by the erasure it records.

        It carries the vault outcome, so that "was this person's résumé actually
        deleted?" has an answer months later, when the only remaining evidence
        is this row and the pending-purge ledger.
      */
      await tx.insert(auditLogs).values({
        action: "hr.recruitment.candidate.erased",
        userId: actorUserId,
        actorUserId,
        orgId,
        targetType: "candidate",
        targetId: String(candidateId),
        resourceType: "candidate",
        resourceId: String(candidateId),
        metadata: {
          vaultStatus: vault.vault,
          vaultObjectsDeleted: vault.objectsDeleted,
          vaultObjectsPendingRetry:
            vault.vault === "NOT_CONFIRMED" ? vault.objectsPendingRetry : 0,
          vaultObjectsLost: vault.vault === "NOT_CONFIRMED" ? vault.objectsLost : 0,
          vaultReason: vault.reason,
        },
      });

      const candidateRows = await tx
        .delete(candidates)
        .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)))
        .returning({ id: candidates.id });

      return {
        applications: applicationRows.length,
        interviews: interviewRows.length,
        slaTracking: slaRows.length,
        vaultDocuments: vaultRows.length,
        candidate: candidateRows.length,
      };
    });

    const status: CandidateErasureStatus =
      vault.vault === "CLEARED" ? "ERASED" : "VAULT_NOT_CONFIRMED";

    return {
      candidateId,
      status,
      recordsDeleted,
      vault,
      summary:
        status === "ERASED"
          ? `The candidate's records were deleted and the résumé vault is confirmed clear. ${vault.reason}`
          : vault.reason,
    };
  }
}

/**
 * Maps the storage layer's outcome onto this module's vocabulary.
 *
 * Exhaustive by construction — a new `PurgeOutcome` member fails to compile
 * here rather than falling through to a default that would quietly report an
 * unknown outcome as a successful delete.
 */
function toObjectOutcome(outcome: PurgeOutcome): ObjectErasureOutcome {
  switch (outcome) {
    case "deleted":
      return "DELETED";
    case "pending_retry":
      return "RETRY_PENDING";
    case "lost":
      return "LOST";
  }
}
