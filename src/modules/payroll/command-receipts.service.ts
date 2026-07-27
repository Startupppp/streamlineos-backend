import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { payrollCommandReceipts } from "../../db/schema";

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

  /**
   * Begin a command under an idempotency key.
   * - Missing key → always fresh (caller should still set a synthetic key for locking).
   * - Existing SUCCEEDED → return stored response (replay).
   * - Existing IN_FLIGHT → concurrent retry.
   * - Existing FAILED → allow a new attempt only when requestHash matches? We re-open as fresh by updating.
   */
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

    if (existing) {
      if (existing.status === "SUCCEEDED") {
        return { kind: "replay", response: existing.response ?? { ok: true } };
      }
      if (existing.status === "IN_FLIGHT") {
        // Stale inflight (>15m) can be reclaimed
        const ageMs = Date.now() - new Date(existing.startedAt).getTime();
        if (ageMs < 15 * 60 * 1000) {
          return { kind: "inflight" };
        }
        await this.db
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
          })
          .where(eq(payrollCommandReceipts.id, existing.id));
        return { kind: "fresh", receiptId: existing.id, correlationId };
      }
      // FAILED → retry same key
      await this.db
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
        })
        .where(eq(payrollCommandReceipts.id, existing.id));
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
        })
        .returning({ id: payrollCommandReceipts.id });
      return { kind: "fresh", receiptId: row!.id, correlationId };
    } catch {
      // Unique race — re-read
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
