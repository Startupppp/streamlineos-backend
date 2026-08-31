import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, getTableColumns, gte, isNull, lte, or, sql } from "drizzle-orm";
import { journalEntries, journalLines, finRecurringJournalTemplates, accNumberSequences } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { buildListResponse, paginateOffset } from "../../../common/pagination/pagination";
import {
  resolveWindowedTotal,
  totalOverWindow,
  withoutTotal,
} from "../../../common/pagination/window-count";
import {
  type CreateRecurringJournalInput,
  type UpdateRecurringJournalInput,
  type RecurringLine,
  recurringLineArraySchema,
} from "./dto/recurring-journals.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function yyyymm(dateIso: string): string {
  return dateIso.slice(0, 7).replace("-", "");
}

function advanceDate(date: string, frequency: string): string {
  const d = new Date(date);
  switch (frequency) {
    case "DAILY": d.setUTCDate(d.getUTCDate() + 1); break;
    case "WEEKLY": d.setUTCDate(d.getUTCDate() + 7); break;
    case "MONTHLY": d.setUTCMonth(d.getUTCMonth() + 1); break;
    case "QUARTERLY": d.setUTCMonth(d.getUTCMonth() + 3); break;
    case "YEARLY": d.setUTCFullYear(d.getUTCFullYear() + 1); break;
  }
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class RecurringJournalsService {
  private readonly logger = new Logger(RecurringJournalsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async listTemplates(orgId: string, page = 1, pageSize = 50) {
    const { offset, limit } = paginateOffset({ page, pageSize });
    const where = eq(finRecurringJournalTemplates.orgId, orgId);
    const rows = await this.db
      .select({ ...getTableColumns(finRecurringJournalTemplates), total: totalOverWindow })
      .from(finRecurringJournalTemplates)
      .where(where)
      .orderBy(finRecurringJournalTemplates.name)
      .offset(offset)
      .limit(limit);

    const total = await resolveWindowedTotal(rows, offset, async () => {
      const fallback = await this.db
        .select({ c: sql<number>`count(*)` })
        .from(finRecurringJournalTemplates)
        .where(where);
      return Number(fallback[0]?.c ?? 0);
    });

    return buildListResponse(withoutTotal(rows), total, { page, pageSize });
  }

  async createTemplate(orgId: string, userId: string, input: CreateRecurringJournalInput) {
    this.validateLines(input.lines);
    const [inserted] = await this.db
      .insert(finRecurringJournalTemplates)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        frequency: input.frequency,
        nextRunDate: input.nextRunDate,
        endDate: input.endDate ?? null,
        lines: input.lines,
        createdBy: userId,
      })
      .returning();
    if (inserted) {
      this.audit.log({
        action: "accounting.recurring_journal.created",
        userId,
        orgId,
        resourceType: "recurring_journal_template",
        resourceId: String(inserted.id),
        result: "SUCCESS",
      });
    }
    return inserted;
  }

  async updateTemplate(orgId: string, templateId: number, input: UpdateRecurringJournalInput) {
    if (input.lines !== undefined) this.validateLines(input.lines);

    const [updated] = await this.db
      .update(finRecurringJournalTemplates)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.frequency !== undefined ? { frequency: input.frequency } : {}),
        ...(input.nextRunDate !== undefined ? { nextRunDate: input.nextRunDate } : {}),
        ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
        ...(input.lines !== undefined ? { lines: input.lines } : {}),
      })
      .where(and(eq(finRecurringJournalTemplates.id, templateId), eq(finRecurringJournalTemplates.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Recurring journal template not found");
    this.audit.log({
      action: "accounting.recurring_journal.updated",
      userId: "system",
      orgId,
      resourceType: "recurring_journal_template",
      resourceId: String(templateId),
      result: "SUCCESS",
    });
    return updated;
  }

  async deleteTemplate(orgId: string, templateId: number) {
    const [deleted] = await this.db
      .delete(finRecurringJournalTemplates)
      .where(and(eq(finRecurringJournalTemplates.id, templateId), eq(finRecurringJournalTemplates.orgId, orgId)))
      .returning({ id: finRecurringJournalTemplates.id });

    if (!deleted) throw new NotFoundException("Recurring journal template not found");
    this.audit.log({
      action: "accounting.recurring_journal.deleted",
      userId: "system",
      orgId,
      resourceType: "recurring_journal_template",
      resourceId: String(templateId),
      result: "SUCCESS",
    });
    return { id: templateId, deleted: true };
  }

  async runNow(orgId: string, userId: string, templateId: number) {
    const tmpl = await this.db
      .select()
      .from(finRecurringJournalTemplates)
      .where(and(eq(finRecurringJournalTemplates.id, templateId), eq(finRecurringJournalTemplates.orgId, orgId)))
      .limit(1);

    if (!tmpl[0]) throw new NotFoundException("Recurring journal template not found");
    if (!tmpl[0].isActive) throw new BadRequestException("Template is inactive");

    const today = todayIso();
    const entry = await this.materializeEntry(tmpl[0], today, userId);
    const nextRun = advanceDate(today, tmpl[0].frequency);

    await this.db
      .update(finRecurringJournalTemplates)
      .set({ lastRunDate: today, nextRunDate: nextRun })
      .where(eq(finRecurringJournalTemplates.id, templateId));

    return entry;
  }

  async runDueTemplates(orgId?: string): Promise<{ processed: number; errors: number }> {
    const today = todayIso();
    const systemUserId = "system";

    const conds = [
      eq(finRecurringJournalTemplates.isActive, true),
      lte(finRecurringJournalTemplates.nextRunDate, today),
      or(isNull(finRecurringJournalTemplates.endDate), gte(finRecurringJournalTemplates.endDate, today)),
    ];
    if (orgId !== undefined) conds.push(eq(finRecurringJournalTemplates.orgId, orgId));

    const templates = await this.db
      .select()
      .from(finRecurringJournalTemplates)
      .where(and(...conds));

    let processed = 0;
    let errors = 0;

    for (const tmpl of templates) {
      try {
        await this.materializeEntry(tmpl, today, systemUserId);
        const nextRun = advanceDate(today, tmpl.frequency);
        await this.db
          .update(finRecurringJournalTemplates)
          .set({ lastRunDate: today, nextRunDate: nextRun })
          .where(eq(finRecurringJournalTemplates.id, tmpl.id));
        processed++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to materialize recurring journal template ${tmpl.id}: ${msg}`);
        errors++;
      }
    }

    return { processed, errors };
  }

  private async materializeEntry(
    tmpl: typeof finRecurringJournalTemplates.$inferSelect,
    entryDate: string,
    userId: string,
  ) {
    const lines = recurringLineArraySchema.parse(tmpl.lines);
    this.validateLines(lines);

    return this.db.transaction(async (tx) => {
      const entryNumber = await this.nextSequenceNumber(tmpl.orgId, entryDate, tx);

      const [entry] = await tx
        .insert(journalEntries)
        .values({
          orgId: tmpl.orgId,
          entryNumber,
          entryDate,
          description: tmpl.name,
          sourceType: "recurring_journal",
          sourceId: String(tmpl.id),
          sourceEvent: entryDate,
          status: "DRAFT",
          createdBy: userId,
        })
        .returning({ id: journalEntries.id, entryNumber: journalEntries.entryNumber });

      if (!entry) throw new Error("Journal entry insert returned no rows");

      const lineRows = lines.map((line, idx) => ({
        entryId: entry.id,
        accountId: line.accountId,
        orgId: tmpl.orgId,
        debit: line.debit.toFixed(4),
        credit: line.credit.toFixed(4),
        description: line.description ?? null,
        lineOrder: idx,
      }));

      await tx.insert(journalLines).values(lineRows);
      return entry;
    });
  }

  private async nextSequenceNumber(orgId: string, entryDate: string, tx: Tx): Promise<string> {
    const inserted = await tx
      .insert(accNumberSequences)
      .values({ orgId, entityType: "journal", prefix: "JE", nextNumber: 2, padding: 5 })
      .onConflictDoUpdate({
        target: [accNumberSequences.orgId, accNumberSequences.entityType],
        set: { nextNumber: sql`${accNumberSequences.nextNumber} + 1` },
      })
      .returning({ next: accNumberSequences.nextNumber, padding: accNumberSequences.padding });

    const row = inserted[0];
    if (!row) throw new Error("Sequence upsert returned no rows");
    const seq = Number(row.next) - 1;
    const pad = Number(row.padding ?? 5);
    const period = yyyymm(entryDate);
    return `JE-${period}-${String(seq).padStart(pad, "0")}`;
  }

  private validateLines(lines: RecurringLine[]): void {
    const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
    const diff = Math.abs(Math.round((totalDebit - totalCredit) * 100) / 100);
    if (diff > 0.009) {
      throw new BadRequestException(`Recurring journal lines are unbalanced: debit=${totalDebit} credit=${totalCredit}`);
    }
  }
}
