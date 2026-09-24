import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { aiActionProposals } from "../../../../db/schema/ai/ai-confirmation";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";

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
        .where(
          and(
            eq(aiActionProposals.id, proposalId),
            eq(aiActionProposals.orgId, orgId),
          ),
        )
        .limit(1),
    { orgId },
  );

  const row = rows[0];
  if (!row) throw new BadRequestException("Proposal not found");

  if (row.status === "EXECUTED") return;

  if (row.status !== "CONFIRMED") {
    throw new BadRequestException(
      "Proposal must be CONFIRMED before marking executed",
    );
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

export async function markProposalDeclined(
  deps: ProposalLifecycleDeps,
  proposalId: number,
  orgId: string,
  userId: string,
): Promise<void> {
  return runInTenantTransaction(
    deps.db,
    async (tx) => {
      const rows = await tx
        .select()
        .from(aiActionProposals)
        .where(
          and(
            eq(aiActionProposals.id, proposalId),
            eq(aiActionProposals.orgId, orgId),
            eq(aiActionProposals.userId, userId),
          ),
        )
        .limit(1);

      const row = rows[0];
      if (!row) throw new NotFoundException("Proposal not found");

      if (row.status === "CANCELLED") return;

      if (row.status !== "PROPOSED") {
        throw new ConflictException("Proposal cannot be declined");
      }

      const now = new Date();
      const declined = await tx
        .update(aiActionProposals)
        .set({ status: "CANCELLED", updatedAt: now })
        .where(
          and(
            eq(aiActionProposals.id, proposalId),
            eq(aiActionProposals.orgId, orgId),
            eq(aiActionProposals.userId, userId),
            eq(aiActionProposals.status, "PROPOSED"),
          ),
        )
        .returning({ id: aiActionProposals.id });

      if (declined.length !== 1) {
        throw new ConflictException(
          "Proposal is no longer in a declinable state",
        );
      }

      deps.audit.log({
        action: "ai.proposal.declined",
        userId: row.userId,
        orgId: row.orgId,
        resourceType: "ai_action_proposal",
        resourceId: String(row.id),
        metadata: { action: row.action },
      });
    },
    { orgId },
  );
}
