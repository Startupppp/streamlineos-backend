import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { and, eq, lt } from "drizzle-orm";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { aiActionProposals } from "../../../../db/schema/ai/ai-confirmation";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";

/**
 * What happens to an AI action proposal after its token is redeemed — or
 * instead of it being redeemed.
 *
 * `ai-confirmation.service.ts` keeps the token protocol: `propose` mints a
 * token bound by HMAC to (proposal, org, user, action, payload hash, expiry),
 * and `confirm` is the one place a token is ever parsed and verified. Nothing
 * in this file reads, mints or checks a token. Every function here takes a
 * proposal id, re-reads the row inside the caller's organisation, and moves or
 * reports its status — CONFIRMED to EXECUTED, PROPOSED to CANCELLED, stale
 * PROPOSED rows to EXPIRED. That is the seam: authorisation-by-token on one
 * side, status bookkeeping on the other.
 *
 * Two rules live here that are easy to lose. `cancel` refuses anyone but the
 * proposing user in the proposing org — a proposal is a pending action on that
 * person's behalf, and cancelling it is a decision about their action.
 * `markProposalExecuted` refuses anything not CONFIRMED, so execution can never
 * be recorded against a proposal nobody confirmed.
 *
 * Bodies moved verbatim from the service, call order included.
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
  await runInTenantTransaction(
    deps.db,
    (tx) =>
      tx
        .update(aiActionProposals)
        .set({ status: "EXECUTED", executedAt: now, result, updatedAt: now })
        .where(eq(aiActionProposals.id, proposalId)),
    { orgId },
  );

  deps.audit.log({
    action: "ai.proposal.executed",
    userId: row.userId,
    orgId: row.orgId,
    resourceType: "ai_action_proposal",
    resourceId: String(row.id),
    metadata: { action: row.action },
  });
}

export async function getProposalExecutedResult(
  deps: ProposalLifecycleDeps,
  proposalId: number,
  orgId: string,
): Promise<Record<string, unknown> | null> {
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
  if (!row || row.status !== "EXECUTED") return null;
  return (row.result ?? null) as Record<string, unknown> | null;
}

export async function cancelProposal(
  deps: ProposalLifecycleDeps,
  proposalId: number,
  actor: { orgId: string; userId: string },
): Promise<void> {
  const rows = await runInTenantTransaction(
    deps.db,
    (tx) =>
      tx
        .select()
        .from(aiActionProposals)
        .where(and(eq(aiActionProposals.id, proposalId), eq(aiActionProposals.orgId, actor.orgId)))
        .limit(1),
    { orgId: actor.orgId },
  );

  const row = rows[0];
  if (!row) throw new BadRequestException("Proposal not found");

  if (row.orgId !== actor.orgId || row.userId !== actor.userId) {
    throw new ForbiddenException("Actor mismatch");
  }

  if (row.status !== "PROPOSED") {
    throw new BadRequestException("Only PROPOSED proposals can be cancelled");
  }

  await runInTenantTransaction(
    deps.db,
    (tx) =>
      tx
        .update(aiActionProposals)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(eq(aiActionProposals.id, proposalId)),
    { orgId: actor.orgId },
  );

  deps.audit.log({
    action: "ai.proposal.cancelled",
    userId: row.userId,
    orgId: row.orgId,
    resourceType: "ai_action_proposal",
    resourceId: String(row.id),
    metadata: { action: row.action },
  });
}

export async function sweepExpiredProposals(deps: ProposalLifecycleDeps): Promise<number> {
  const updated = await deps.db
    .update(aiActionProposals)
    .set({ status: "EXPIRED", updatedAt: new Date() })
    .where(
      and(
        eq(aiActionProposals.status, "PROPOSED"),
        lt(aiActionProposals.expiresAt, new Date()),
      ),
    )
    .returning({ id: aiActionProposals.id });

  return updated.length;
}
