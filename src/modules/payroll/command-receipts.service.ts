import { ConflictException, Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { payrollCommandReceipts } from "../../db/schema";
import { getPostgresErrorCode } from "../../common/db/postgres-error";
import { logger } from "../../common/logger/logger.service";

export type PayrollCommandName =
  | "run.create"
  | "run.generate"
  | "run.recalculate"
  | "run.lock"
  | "run.reopen"
  | "run.close"
  | "run.mark_paid"
  | "run.publish_payslips"
  | "run.submit_approval"
  | "run.approve_stage"
  | "run.reject_stage"
  | "payout.create_batch"
  | "payout.mark_sent"
  | "payout.mark_paid";

export type CommandBeginResult =
  | { kind: "replay"; response: unknown }
  | { kind: "inflight" }
  | { kind: "fresh"; receiptId: number; correlationId: string };

@Injectable()
export class PayrollCommandReceiptsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  hashRequest(body: unknown): string {
    return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
  }

  async begin(params: {
    orgId: string;
    command: PayrollCommandName;
    idempotencyKey: string;
    actorId: string;
    runId?: number | null;
    requestHash?: string | null;
  }): Promise<CommandBeginResult> {
    const correlationId = randomUUID();
    const existing = await this.db.query.payrollCommandReceipts.findFirst({
      where: and(
        eq(payrollCommandReceipts.orgId, params.orgId),
        eq(payrollCommandReceipts.command, params.command),
        eq(payrollCommandReceipts.idempotencyKey, params.idempotencyKey),
      ),
    });

    const receiptExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    if (existing) {
      if (existing.status === "SUCCEEDED") {
        return { kind: "replay", response: existing.response ?? { ok: true } };
      }

      if (
        existing.requestHash !== null &&
        params.requestHash !== null &&
        params.requestHash !== undefined &&
        existing.requestHash !== params.requestHash
      ) {
        throw new UnprocessableEntityException(
          "This idempotency key was already used with a different request body",
        );
      }

      if (existing.status === "IN_FLIGHT") {
        const ageMs = Date.now() - new Date(existing.startedAt).getTime();
        if (ageMs < 15 * 60 * 1000) {
          return { kind: "inflight" };
        }
        const reclaimed = await this.db
          .update(payrollCommandReceipts)
          .set({
            status: "IN_FLIGHT",
            actorId: params.actorId,
            requestHash: params.requestHash ?? existing.requestHash,
            correlationId,
            startedAt: new Date(),
            finishedAt: null,
            errorMessage: null,
            response: null,
            runId: params.runId ?? existing.runId,
            expiresAt: receiptExpiresAt,
          })
          .where(
            and(
              eq(payrollCommandReceipts.id, existing.id),
              eq(payrollCommandReceipts.startedAt, existing.startedAt),
            ),
          )
          .returning({ id: payrollCommandReceipts.id });
        if (reclaimed.length === 0) return { kind: "inflight" };
        return { kind: "fresh", receiptId: existing.id, correlationId };
      }

      const reclaimed = await this.db
        .update(payrollCommandReceipts)
        .set({
          status: "IN_FLIGHT",
          actorId: params.actorId,
          requestHash: params.requestHash ?? existing.requestHash,
          correlationId,
          startedAt: new Date(),
          finishedAt: null,
          errorMessage: null,
          response: null,
          runId: params.runId ?? existing.runId,
          expiresAt: receiptExpiresAt,
        })
        .where(
          and(
            eq(payrollCommandReceipts.id, existing.id),
            eq(payrollCommandReceipts.startedAt, existing.startedAt),
          ),
        )
        .returning({ id: payrollCommandReceipts.id });
      if (reclaimed.length === 0) return { kind: "inflight" };
      return { kind: "fresh", receiptId: existing.id, correlationId };
    }

    try {
      const [row] = await this.db
        .insert(payrollCommandReceipts)
        .values({
          orgId: params.orgId,
          runId: params.runId ?? null,
          command: params.command,
          idempotencyKey: params.idempotencyKey,
          status: "IN_FLIGHT",
          requestHash: params.requestHash ?? null,
          correlationId,
          actorId: params.actorId,
          expiresAt: receiptExpiresAt,
        })
        .returning({ id: payrollCommandReceipts.id });
      return { kind: "fresh", receiptId: row!.id, correlationId };
    } catch (err) {
      if (getPostgresErrorCode(err) !== "23505") {
        logger.error("command-receipts.begin: receipt insert failed unexpectedly", {
          command: params.command,
          cause: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      const raced = await this.db.query.payrollCommandReceipts.findFirst({
        where: and(
          eq(payrollCommandReceipts.orgId, params.orgId),
          eq(payrollCommandReceipts.command, params.command),
          eq(payrollCommandReceipts.idempotencyKey, params.idempotencyKey),
        ),
      });
      if (raced?.status === "SUCCEEDED") {
        return { kind: "replay", response: raced.response ?? { ok: true } };
      }
      throw new ConflictException("A concurrent payroll command is already in flight for this key");
    }
  }

  async succeed(receiptId: number, response: unknown): Promise<void> {
    await this.db
      .update(payrollCommandReceipts)
      .set({
        status: "SUCCEEDED",
        response: response as object,
        finishedAt: new Date(),
        errorMessage: null,
      })
      .where(eq(payrollCommandReceipts.id, receiptId));
  }

  async fail(receiptId: number, errorMessage: string): Promise<void> {
    await this.db
      .update(payrollCommandReceipts)
      .set({
        status: "FAILED",
        errorMessage,
        finishedAt: new Date(),
      })
      .where(eq(payrollCommandReceipts.id, receiptId));
  }
}
