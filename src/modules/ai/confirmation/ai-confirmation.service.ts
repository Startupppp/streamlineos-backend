import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, lt } from "drizzle-orm";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { aiActionProposals } from "../../../db/schema/ai/ai-confirmation";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";

export interface ProposeInput {
  orgId: string;
  userId: string;
  action: string;
  payload: Record<string, unknown>;
  ttlSeconds?: number;
  idempotencyKey?: string;
}

export interface ProposeResult {
  proposalId: number;
  token: string;
  expiresAt: Date;
}

export interface ConfirmInput {
  token: string;
  actor: { orgId: string; userId: string };
}

export interface ConfirmResult {
  proposalId: number;
  action: string;
  payload: Record<string, unknown>;
}

const MAX_TTL = 300;
const DEFAULT_TTL = 120;

function stableHash(payload: Record<string, unknown>): string {
  const sorted = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(sorted).digest("hex");
}

function computeHmac(
  secret: string,
  proposalId: number,
  orgId: string,
  userId: string,
  action: string,
  payloadHash: string,
  expiresAtEpoch: number,
): string {
  const data = `${proposalId}:${orgId}:${userId}:${action}:${payloadHash}:${expiresAtEpoch}`;
  return createHmac("sha256", secret).update(data).digest("hex");
}

function getSecret(): string {
  return process.env.AI_CONFIRMATION_SECRET ?? process.env.BACKEND_JWT_SECRET ?? "";
}

@Injectable()
export class AiConfirmationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async propose(input: ProposeInput): Promise<ProposeResult> {
    const ttl = Math.min(input.ttlSeconds ?? DEFAULT_TTL, MAX_TTL);
    const payloadHash = stableHash(input.payload);
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const idempotencyKey = input.idempotencyKey;
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

    const [inserted] = await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .insert(aiActionProposals)
          .values({
            orgId: input.orgId,
            userId: input.userId,
            action: input.action,
            payload: input.payload,
            payloadHash,
            idempotencyKey: input.idempotencyKey ?? null,
            expiresAt,
          })
          .returning(),
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
            .where(eq(aiActionProposals.id, proposalId));
        }
        throw new BadRequestException("Proposal has expired");
      }

      if (row.orgId !== input.actor.orgId || row.userId !== input.actor.userId) {
        throw new ForbiddenException("Actor mismatch");
      }

      const secret = getSecret();
      const expectedHmac = computeHmac(secret, row.id, row.orgId, row.userId, row.action, row.payloadHash, expiresAtEpoch);

      const expected = Buffer.from(expectedHmac, "hex");
      const provided = Buffer.from(providedHmac, "hex");

      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        throw new ForbiddenException("Token signature mismatch");
      }

      await tx
        .update(aiActionProposals)
        .set({ status: "CONFIRMED", updatedAt: now })
        .where(eq(aiActionProposals.id, proposalId));

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

  async markExecuted(
    proposalId: number,
    result: Record<string, unknown>,
    orgId: string,
  ): Promise<void> {
    const rows = await runInTenantTransaction(
      this.db,
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
      this.db,
      (tx) =>
        tx
          .update(aiActionProposals)
          .set({ status: "EXECUTED", executedAt: now, result, updatedAt: now })
          .where(eq(aiActionProposals.id, proposalId)),
      { orgId },
    );

    this.audit.log({
      action: "ai.proposal.executed",
      userId: row.userId,
      orgId: row.orgId,
      resourceType: "ai_action_proposal",
      resourceId: String(row.id),
      metadata: { action: row.action },
    });
  }

  async getExecutedResult(
    proposalId: number,
    orgId: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await runInTenantTransaction(
      this.db,
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
    return row.result ?? null;
  }

  async cancel(proposalId: number, actor: { orgId: string; userId: string }): Promise<void> {
    const rows = await runInTenantTransaction(
      this.db,
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
      this.db,
      (tx) =>
        tx
          .update(aiActionProposals)
          .set({ status: "CANCELLED", updatedAt: new Date() })
          .where(eq(aiActionProposals.id, proposalId)),
      { orgId: actor.orgId },
    );

    this.audit.log({
      action: "ai.proposal.cancelled",
      userId: row.userId,
      orgId: row.orgId,
      resourceType: "ai_action_proposal",
      resourceId: String(row.id),
      metadata: { action: row.action },
    });
  }

  async sweepExpired(): Promise<number> {
    const updated = await this.db
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
}