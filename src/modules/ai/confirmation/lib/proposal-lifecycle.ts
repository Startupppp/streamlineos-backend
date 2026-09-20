import { BadRequestException, ConflictException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { aiActionProposals } from "../../../../db/schema/ai/ai-confirmation";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";

/**
 * What happens to an AI action proposal after its token is redeemed.
 *
 * `ai-confirmation.service.ts` keeps the token protocol: `propose` mints a
 * token bound by HMAC to (proposal, org, user, action, payload hash, expiry),
 * and `confirm` is the one place a token is ever parsed and verified. Nothing
 * in this file reads, mints or checks a token. It takes a proposal id, re-reads
 * the row inside the caller's organisation, and moves CONFIRMED to EXECUTED.
 * That is the seam: authorisation-by-token on one side, status bookkeeping on
 * the other.
 *
 * `markProposalExecuted` refuses anything not CONFIRMED, so execution can never
 * be recorded against a proposal nobody confirmed — and the write re-states
 * both that status and the organisation, so the rule holds without the read in
 * front of it and cannot be lost to a concurrent transition.
 *
 * Expiry needs no sweep: `confirm` refuses a proposal past `expires_at` and
 * stamps it EXPIRED on the way out, and `propose` treats an expired row as no
 * row. A cross-tenant sweep would have had no organisation predicate and no
 * tenant GUC, which is a `42501` the moment `1123` enables RLS on the table.
 */

export interface ProposalLifecycleDeps {
  readonly db: Db;
  readonly audit: AuditService;
}

export async function markProposalExecuted(
  deps: ProposalLifecycleDeps,
  proposalId: number,
  result: Record<string, unknown>,
  orgId: string,
): Promise<void> {
  const rows = await runInTenantTransaction(
    deps.db,
    (tx) =>
      tx
        .select()
        .from(aiActionProposals)
        .where(and(eq(aiActionProposals.id, proposalId), eq(aiActionProposals.orgId, orgId)))
        .limit(1),
    { orgId },
  );

  const row = rows[0];
  if (!row) throw new BadRequestException("Proposal not found");

  if (row.status === "EXECUTED") return;

  if (row.status !== "CONFIRMED") {
    throw new BadRequestException("Proposal must be CONFIRMED before marking executed");
  }

  const now = new Date();
  const executed = await runInTenantTransaction(
    deps.db,
    (tx) =>
      tx
        .update(aiActionProposals)
        .set({ status: "EXECUTED", executedAt: now, result, updatedAt: now })
        .where(
          and(
            eq(aiActionProposals.id, proposalId),
            eq(aiActionProposals.orgId, orgId),
            eq(aiActionProposals.status, "CONFIRMED"),
          ),
        )
        .returning({ id: aiActionProposals.id }),
    { orgId },
  );

  if (executed.length !== 1) {
    throw new ConflictException("Proposal is no longer CONFIRMED");
  }

  deps.audit.log({
    action: "ai.proposal.executed",
    userId: row.userId,
    orgId: row.orgId,
    resourceType: "ai_action_proposal",
    resourceId: String(row.id),
    metadata: { action: row.action },
  });
}
