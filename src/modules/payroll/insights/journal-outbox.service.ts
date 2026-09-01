import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollJournalBatches, payrollJournalBatchLines, organizationMembers } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { JournalService, type JournalLine } from "./journal.service";
import { findRunForMonth } from "./lib/report-builders";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import {
  journalBatchLineSelection,
  journalBatchSummarySelection,
  toJournalBatchSummary,
  type JournalBatchDetail,
  type JournalBatchStatus,
  type JournalBatchSummary,
  type JournalReconStatus,
} from "./journal-batch-read-model";

export type {
  JournalBatchDetail,
  JournalBatchStatus,
  JournalBatchSummary,
  JournalReconStatus,
} from "./journal-batch-read-model";

const money = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

/**
 * A batch is identified by the exact journal content it was built from, so
 * rebuilding an unchanged run is a no-op instead of creating a duplicate.
 */
function hashJournal(runId: number | null, lines: JournalLine[]): string {
  const canonical = JSON.stringify({
    runId,
    lines: lines.map((l) => [l.account, l.description, l.debit, l.credit, l.costCenter]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

@Injectable()
export class JournalOutboxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly journalService: JournalService,
    private readonly audit: AuditService,
  ) {}

  private async resolveMembershipId(orgId: string, userId: string): Promise<number | null> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId)),
      columns: { id: true },
    });
    return member?.id ?? null;
  }

  async list(
    orgId: string,
    filters: { periodKey?: string; status?: JournalBatchStatus; page?: number; limit?: number },
  ): Promise<{ data: JournalBatchSummary[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 25));

    const conditions = [eq(payrollJournalBatches.orgId, orgId)];
    if (filters.periodKey) {
      conditions.push(eq(payrollJournalBatches.periodKey, filters.periodKey));
    }
    if (filters.status) {
      conditions.push(eq(payrollJournalBatches.status, filters.status));
    }
    const where = and(...conditions);

    const [rows, countRows] = await Promise.all([
      this.db
        .select(journalBatchSummarySelection)
        .from(payrollJournalBatches)
        .where(where)
        .orderBy(desc(payrollJournalBatches.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(payrollJournalBatches)
        .where(where),
    ]);

    return {
      data: rows.map(toJournalBatchSummary),
      total: countRows[0]?.count ?? 0,
      page,
      limit,
    };
  }

  async get(orgId: string, batchId: number): Promise<JournalBatchDetail> {
    const batch = await this.requireBatch(orgId, batchId);
    const lines = await this.db
      .select(journalBatchLineSelection)
      .from(payrollJournalBatchLines)
      .where(eq(payrollJournalBatchLines.batchId, batchId))
      .orderBy(payrollJournalBatchLines.lineNo);

    return { ...toJournalBatchSummary(batch), lines };
  }

  /**
   * Snapshot the current journal for a period into a new immutable batch.
   * Refuses provisional (pre-lock) runs unless the caller explicitly opts in,
   * because an unlocked run can still change underneath the ledger.
   */
  async createBatch(
    orgId: string,
    userId: string,
    input: { periodKey: string; allowProvisional?: boolean; note?: string },
  ): Promise<JournalBatchDetail> {
    const { periodKey } = input;

    const run = await findRunForMonth(this.db, orgId, periodKey);
    if (run === null) {
      throw new NotFoundException(`No payroll run found for ${periodKey}.`);
    }

    const provisional = !PAYROLL_LOCKED_STATUSES.includes(run.status);
    if (provisional && input.allowProvisional !== true) {
      throw new BadRequestException(
        `Payroll run for ${periodKey} is not approved or locked (status ${run.status}). ` +
          "Post a provisional batch explicitly if you intend to accrue before lock.",
      );
    }

    const journal = await this.journalService.buildJournal(orgId, periodKey);
    if (journal.lines.length === 0) {
      throw new BadRequestException(`Journal for ${periodKey} has no lines to post.`);
    }

    const sourceHash = hashJournal(run.id, journal.lines);
    const createdByMembershipId = await this.resolveMembershipId(orgId, userId);

    const existing = await this.db
      .select()
      .from(payrollJournalBatches)
      .where(
        and(
          eq(payrollJournalBatches.orgId, orgId),
          eq(payrollJournalBatches.sourceHash, sourceHash),
        ),
      )
      .limit(1);

    const priorBatch = existing[0];
    if (priorBatch !== undefined && priorBatch.status !== "REVERSED") {
      return this.get(orgId, priorBatch.id);
    }

    const batchId = await this.db.transaction(async (tx) => {
      const versionRows = await tx
        .select({ maxVersion: sql<number>`coalesce(max(${payrollJournalBatches.version}), 0)::int` })
        .from(payrollJournalBatches)
        .where(
          and(
            eq(payrollJournalBatches.orgId, orgId),
            eq(payrollJournalBatches.periodKey, periodKey),
          ),
        );
      const nextVersion = (versionRows[0]?.maxVersion ?? 0) + 1;

      const inserted = await tx
        .insert(payrollJournalBatches)
        .values({
          orgId,
          runId: run.id,
          periodKey,
          version: nextVersion,
          status: "DRAFT",
          provisional,
          sourceHash,
          totalDebits: money(journal.totalDebits),
          totalCredits: money(journal.totalCredits),
          lineCount: journal.lines.length,
          unmappedCodes: journal.unmappedCodes,
          note: input.note ?? null,
          createdBy: userId,
          createdByMembershipId,
        })
        .returning({ id: payrollJournalBatches.id });

      const newId = inserted[0]?.id;
      if (newId === undefined) throw new ConflictException("Failed to create journal batch.");

      await tx.insert(payrollJournalBatchLines).values(
        journal.lines.map((line, idx) => ({
          orgId,
          batchId: newId,
          lineNo: idx + 1,
          account: line.account,
          description: line.description,
          debit: money(line.debit),
          credit: money(line.credit),
          costCenter: line.costCenter,
        })),
      );

      return newId;
    });

    this.audit.log({
      action: "payroll.journal_batch_created",
      userId,
      orgId,
      targetId: String(batchId),
      targetType: "payroll_journal_batch",
      metadata: {
        periodKey,
        runId: run.id,
        provisional,
        totalDebits: money(journal.totalDebits),
        totalCredits: money(journal.totalCredits),
        unmappedCodes: journal.unmappedCodes,
      },
    });

    return this.get(orgId, batchId);
  }

  async markPosted(orgId: string, userId: string, batchId: number): Promise<JournalBatchDetail> {
    const batch = await this.requireBatch(orgId, batchId);
    if (batch.status !== "DRAFT" && batch.status !== "FAILED") {
      throw new BadRequestException(`Batch is ${batch.status} and cannot be posted again.`);
    }
    if (batch.totalDebits !== batch.totalCredits) {
      throw new BadRequestException(
        `Batch does not balance: debits ${batch.totalDebits} vs credits ${batch.totalCredits}.`,
      );
    }

    const postedByMembershipId = await this.resolveMembershipId(orgId, userId);
    await this.db
      .update(payrollJournalBatches)
      .set({ status: "POSTED", postedAt: new Date(), postedBy: userId, postedByMembershipId })
      .where(
        and(eq(payrollJournalBatches.orgId, orgId), eq(payrollJournalBatches.id, batchId)),
      );

    this.audit.log({
      action: "payroll.journal_batch_posted",
      userId,
      orgId,
      targetId: String(batchId),
      targetType: "payroll_journal_batch",
      metadata: { periodKey: batch.periodKey, version: batch.version },
    });

    return this.get(orgId, batchId);
  }

  async markExported(orgId: string, userId: string, batchId: number): Promise<JournalBatchDetail> {
    const batch = await this.requireBatch(orgId, batchId);
    if (batch.status !== "POSTED" && batch.status !== "EXPORTED") {
      throw new BadRequestException(`Only a posted batch can be exported (batch is ${batch.status}).`);
    }

    const exportedByMembershipId = await this.resolveMembershipId(orgId, userId);
    await this.db
      .update(payrollJournalBatches)
      .set({ status: "EXPORTED", exportedAt: new Date(), exportedBy: userId, exportedByMembershipId })
      .where(
        and(eq(payrollJournalBatches.orgId, orgId), eq(payrollJournalBatches.id, batchId)),
      );

    this.audit.log({
      action: "payroll.journal_batch_exported",
      userId,
      orgId,
      targetId: String(batchId),
      targetType: "payroll_journal_batch",
      metadata: { periodKey: batch.periodKey, version: batch.version },
    });

    return this.get(orgId, batchId);
  }

  /**
   * A posted batch is never mutated. Reversal writes a new contra batch with
   * debits and credits swapped, links it back to the original, and marks the
   * original REVERSED — leaving both sides visible to the auditor.
   */
  async reverseBatch(
    orgId: string,
    userId: string,
    batchId: number,
    reason: string,
  ): Promise<JournalBatchDetail> {
    const batch = await this.requireBatch(orgId, batchId);
    if (batch.status !== "POSTED" && batch.status !== "EXPORTED") {
      throw new BadRequestException(
        `Only a posted or exported batch can be reversed (batch is ${batch.status}).`,
      );
    }
    if (batch.reversalOfBatchId !== null) {
      throw new BadRequestException("A reversal batch cannot itself be reversed.");
    }

    const originalLines = await this.db
      .select()
      .from(payrollJournalBatchLines)
      .where(eq(payrollJournalBatchLines.batchId, batchId))
      .orderBy(payrollJournalBatchLines.lineNo);

    const reversalActorMembershipId = await this.resolveMembershipId(orgId, userId);

    const reversalId = await this.db.transaction(async (tx) => {
      const versionRows = await tx
        .select({ maxVersion: sql<number>`coalesce(max(${payrollJournalBatches.version}), 0)::int` })
        .from(payrollJournalBatches)
        .where(
          and(
            eq(payrollJournalBatches.orgId, orgId),
            eq(payrollJournalBatches.periodKey, batch.periodKey),
          ),
        );
      const nextVersion = (versionRows[0]?.maxVersion ?? 0) + 1;

      const inserted = await tx
        .insert(payrollJournalBatches)
        .values({
          orgId,
          entityId: batch.entityId,
          runId: batch.runId,
          periodKey: batch.periodKey,
          version: nextVersion,
          status: "POSTED",
          provisional: batch.provisional,
          reversalOfBatchId: batch.id,
          reversalReason: reason,
          sourceHash: `reversal:${batch.sourceHash}:v${nextVersion}`,
          totalDebits: batch.totalCredits,
          totalCredits: batch.totalDebits,
          lineCount: originalLines.length,
          unmappedCodes: batch.unmappedCodes,
          note: `Reversal of batch #${batch.id} (v${batch.version})`,
          postedAt: new Date(),
          postedBy: userId,
          postedByMembershipId: reversalActorMembershipId,
          createdBy: userId,
          createdByMembershipId: reversalActorMembershipId,
        })
        .returning({ id: payrollJournalBatches.id });

      const newId = inserted[0]?.id;
      if (newId === undefined) throw new ConflictException("Failed to create reversal batch.");

      if (originalLines.length > 0) {
        await tx.insert(payrollJournalBatchLines).values(
          originalLines.map((line, idx) => ({
            orgId,
            batchId: newId,
            lineNo: idx + 1,
            account: line.account,
            description: `Reversal — ${line.description}`,
            debit: line.credit,
            credit: line.debit,
            costCenter: line.costCenter,
          })),
        );
      }

      await tx
        .update(payrollJournalBatches)
        .set({ status: "REVERSED", reversedAt: new Date(), reversedBy: userId, reversedByMembershipId: reversalActorMembershipId, reversalReason: reason })
        .where(
          and(eq(payrollJournalBatches.orgId, orgId), eq(payrollJournalBatches.id, batchId)),
        );

      return newId;
    });

    this.audit.log({
      action: "payroll.journal_batch_reversed",
      userId,
      orgId,
      targetId: String(batchId),
      targetType: "payroll_journal_batch",
      metadata: { periodKey: batch.periodKey, reason, reversalBatchId: reversalId },
    });

    return this.get(orgId, reversalId);
  }

  async reconcile(
    orgId: string,
    userId: string,
    batchId: number,
    input: { status: JournalReconStatus; note?: string },
  ): Promise<JournalBatchDetail> {
    const batch = await this.requireBatch(orgId, batchId);
    if (batch.status === "DRAFT") {
      throw new BadRequestException("A draft batch cannot be reconciled — post it first.");
    }

    const reconciled = input.status === "UNRECONCILED" ? null : new Date();
    const reconciledByMembershipId = reconciled === null ? null : await this.resolveMembershipId(orgId, userId);

    await this.db
      .update(payrollJournalBatches)
      .set({
        reconciliationStatus: input.status,
        reconciliationNote: input.note ?? null,
        reconciledAt: reconciled,
        reconciledBy: reconciled === null ? null : userId,
        reconciledByMembershipId,
      })
      .where(
        and(eq(payrollJournalBatches.orgId, orgId), eq(payrollJournalBatches.id, batchId)),
      );

    this.audit.log({
      action: "payroll.journal_batch_reconciled",
      userId,
      orgId,
      targetId: String(batchId),
      targetType: "payroll_journal_batch",
      metadata: { periodKey: batch.periodKey, status: input.status, note: input.note ?? null },
    });

    return this.get(orgId, batchId);
  }

  private async requireBatch(orgId: string, batchId: number) {
    const rows = await this.db
      .select()
      .from(payrollJournalBatches)
      .where(
        and(eq(payrollJournalBatches.orgId, orgId), eq(payrollJournalBatches.id, batchId)),
      )
      .limit(1);
    const batch = rows[0];
    if (batch === undefined) throw new NotFoundException("Journal batch not found.");
    return batch;
  }

}
