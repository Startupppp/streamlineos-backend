import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { aiActionProposals } from "../../../db/schema/ai/ai-confirmation";
import { organizationMembers } from "../../../db/schema";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import {
  cancelProposal,
  getProposalExecutedResult,
  markProposalExecuted,
  sweepExpiredProposals,
  type ProposalLifecycleDeps,
} from "./lib/proposal-lifecycle";
import { boundedIdempotencyKey, computeHmac, DEFAULT_TTL, getSecret, MAX_TTL, stableHash, type ConfirmInput, type ConfirmResult, type ProposeInput, type ProposeResult } from "./ai-confirmation.helpers";

/**
 * The token protocol for AI-proposed actions: `propose` mints a token bound by
 * HMAC to the proposal, org, user, action, payload hash and expiry, and
 * `confirm` is the only place one is ever verified. What happens to a proposal
 * afterwards (execution bookkeeping, result lookup, cancellation, the expiry
 * sweep) never touches a token and lives in `lib/proposal-lifecycle.ts`.
 */
@Injectable()
export class AiConfirmationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async resolveMembershipId(orgId: string, userId: string): Promise<number | null> {
    const rows = await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.orgId, orgId),
              eq(organizationMembers.userId, userId),
            ),
          )
          .limit(1),
      { orgId },
    );
    return rows[0]?.id ?? null;
  }

  async propose(input: ProposeInput): Promise<ProposeResult> {
    const ttl = Math.min(input.ttlSeconds ?? DEFAULT_TTL, MAX_TTL);
    const payloadHash = stableHash(input.payload);
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const idempotencyKey = input.idempotencyKey
      ? boundedIdempotencyKey(input.idempotencyKey)
      : undefined;
    if (idempotencyKey) {
      const existing = await runInTenantTransaction(
        this.db,
        (tx) =>
          tx
            .select()
            .from(aiActionProposals)
            .where(
              and(
                eq(aiActionProposals.orgId, input.orgId),
                eq(aiActionProposals.idempotencyKey, idempotencyKey),
                eq(aiActionProposals.status, "PROPOSED"),
              ),
            )
            .limit(1),
        { orgId: input.orgId },
      );

      const row = existing[0];
      if (row && row.expiresAt > new Date()) {
        const secret = getSecret();
        const epoch = Math.floor(row.expiresAt.getTime() / 1000);
        const hmac = computeHmac(secret, row.id, row.orgId, row.userId, row.action, row.payloadHash, epoch);
        const token = `${row.id}.${epoch}.${hmac}`;
        return { proposalId: row.id, token, expiresAt: row.expiresAt };
      }
    }

    const userMembershipId = await this.resolveMembershipId(input.orgId, input.userId);

    const inserted = await runInTenantTransaction(
      this.db,
      async (tx) => {
        try {
          const [row] = await tx
            .insert(aiActionProposals)
            .values({
              orgId: input.orgId,
              userId: input.userId,
              userMembershipId,
              action: input.action,
              payload: input.payload,
              payloadHash,
              idempotencyKey: idempotencyKey ?? null,
              expiresAt,
            })
            .returning();
          return row;
        } catch (error) {
          if (!isUniqueViolation(error) || idempotencyKey === undefined) throw error;
          const [existing] = await tx
            .select()
            .from(aiActionProposals)
            .where(
              and(
                eq(aiActionProposals.orgId, input.orgId),
                eq(aiActionProposals.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1);
          if (!existing || existing.status !== "PROPOSED" || existing.expiresAt <= new Date())
            throw new ConflictException(
              "That action was already proposed. Ask again in a moment or confirm the pending card.",
            );
          return existing;
        }
      },
      { orgId: input.orgId },
    );

    if (!inserted) throw new BadRequestException("Failed to create proposal");

    const secret = getSecret();
    const epoch = Math.floor(inserted.expiresAt.getTime() / 1000);
    const hmac = computeHmac(secret, inserted.id, inserted.orgId, inserted.userId, inserted.action, inserted.payloadHash, epoch);
    const token = `${inserted.id}.${epoch}.${hmac}`;

    this.audit.log({
      action: "ai.proposal.proposed",
      userId: input.userId,
      orgId: input.orgId,
      resourceType: "ai_action_proposal",
      resourceId: String(inserted.id),
      metadata: { action: input.action, ttl },
    });

    return { proposalId: inserted.id, token, expiresAt: inserted.expiresAt };
  }

  async confirm(input: ConfirmInput): Promise<ConfirmResult> {
    const parts = input.token.split(".");
    if (parts.length !== 3) throw new ForbiddenException("Invalid token format");

    const [idStr, epochStr, providedHmac] = parts;
    const proposalId = parseInt(idStr ?? "", 10);
    const expiresAtEpoch = parseInt(epochStr ?? "", 10);

    if (isNaN(proposalId) || isNaN(expiresAtEpoch) || !providedHmac) {
      throw new ForbiddenException("Invalid token format");
    }

    return runInTenantTransaction(this.db, async (tx) => {
      const rows = await tx
        .select()
        .from(aiActionProposals)
        .where(and(eq(aiActionProposals.id, proposalId), eq(aiActionProposals.orgId, input.actor.orgId)))
        .for("update")
        .limit(1);

      const row = rows[0];
      if (!row) throw new NotFoundException("Proposal not found");

      if (row.orgId !== input.actor.orgId || row.userId !== input.actor.userId) {
        throw new NotFoundException("Proposal not found");
      }

      if (row.status === "CONFIRMED" || row.status === "EXECUTED") {
        throw new ConflictException("Proposal already confirmed or executed");
      }

      if (row.status === "CANCELLED") {
        throw new BadRequestException("Proposal was cancelled");
      }

      const now = new Date();
      if (row.status === "EXPIRED" || now > row.expiresAt) {
        if (row.status === "PROPOSED") {
          await tx
            .update(aiActionProposals)
            .set({ status: "EXPIRED", updatedAt: now })
            .where(
              and(
                eq(aiActionProposals.id, proposalId),
                eq(aiActionProposals.orgId, input.actor.orgId),
                eq(aiActionProposals.status, "PROPOSED"),
              ),
            );
        }
        throw new BadRequestException("Proposal has expired");
      }

      if (stableHash(row.payload ?? {}) !== row.payloadHash) {
        throw new ForbiddenException("Proposal payload does not match its signature");
      }

      const secret = getSecret();
      const expectedHmac = computeHmac(secret, row.id, row.orgId, row.userId, row.action, row.payloadHash, expiresAtEpoch);

      const expected = Buffer.from(expectedHmac, "hex");
      const provided = Buffer.from(providedHmac, "hex");

      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        throw new ForbiddenException("Token signature mismatch");
      }

      const redeemed = await tx
        .update(aiActionProposals)
        .set({ status: "CONFIRMED", updatedAt: now })
        .where(
          and(
            eq(aiActionProposals.id, proposalId),
            eq(aiActionProposals.orgId, input.actor.orgId),
            eq(aiActionProposals.status, "PROPOSED"),
          ),
        )
        .returning({ id: aiActionProposals.id });

      if (redeemed.length !== 1) {
        throw new ConflictException("Proposal already confirmed or executed");
      }

      this.audit.log({
        action: "ai.proposal.confirmed",
        userId: row.userId,
        orgId: row.orgId,
        resourceType: "ai_action_proposal",
        resourceId: String(row.id),
        metadata: { action: row.action },
      });

      return {
        proposalId: row.id,
        action: row.action,
        payload: row.payload ?? {},
      };
    }, { orgId: input.actor.orgId });
  }

  private get lifecycleDeps(): ProposalLifecycleDeps {
    return { db: this.db, audit: this.audit };
  }

  async markExecuted(
    proposalId: number,
    result: Record<string, unknown>,
    orgId: string,
  ): Promise<void> {
    return markProposalExecuted(this.lifecycleDeps, proposalId, result, orgId);
  }

  async getExecutedResult(
    proposalId: number,
    orgId: string,
  ): Promise<Record<string, unknown> | null> {
    return getProposalExecutedResult(this.lifecycleDeps, proposalId, orgId);
  }

  async cancel(proposalId: number, actor: { orgId: string; userId: string }): Promise<void> {
    return cancelProposal(this.lifecycleDeps, proposalId, actor);
  }

  async sweepExpired(): Promise<number> {
    return sweepExpiredProposals(this.lifecycleDeps);
  }
}
