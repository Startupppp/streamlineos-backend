import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, getTableColumns, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { journalEntries, journalLines, finRecurringJournalTemplates, accNumberSequences } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../common/pagination/cursor";
import { keysetAfterValue } from "../../../common/pagination/keyset";
import {
  type CreateRecurringJournalInput,
  type UpdateRecurringJournalInput,
  type RecurringLine,
  recurringLineArraySchema,
} from "./dto/recurring-journals.schemas";
import { compareDecimals, decimalFromNumber, sumDecimals } from "../core/money.util";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A due template whose lines already parsed and balanced, so only database work is left. */
interface DueTemplate {
  tmpl: typeof finRecurringJournalTemplates.$inferSelect;
  lines: RecurringLine[];
}

/**
 * Due templates claimed and posted in one transaction.
 *
 * The cap is the multi-row INSERT, not the transaction: a template carries at
 * most 100 lines (`createRecurringJournalSchema`) and a line binds 7 columns, so
 * 50 templates is at most 35,000 bound parameters — comfortably under the 65,535
 * one Postgres statement can carry, with the entry insert on top. It is also the
 * unit of failure: a database error rolls back the whole chunk and charges every
 * template in it to `errors`, which is why the in-memory validation that used to
 * fail one template at a time runs BEFORE the chunking.
 */
const RUN_BATCH = 50;

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

  async listTemplates(orgId: string, cursor?: string, limit = 50): Promise<CursorPage<typeof finRecurringJournalTemplates.$inferSelect>> {
    const pos = decodeCursor(cursor);
    const conds = [eq(finRecurringJournalTemplates.orgId, orgId)];
    if (pos) conds.push(keysetAfterValue(finRecurringJournalTemplates.name, finRecurringJournalTemplates.id, pos));
    const rows = await this.db
      .select(getTableColumns(finRecurringJournalTemplates))
      .from(finRecurringJournalTemplates)
      .where(and(...conds))
      .orderBy(asc(finRecurringJournalTemplates.name), asc(finRecurringJournalTemplates.id))
      .limit(limit + 1);
    return buildCursorPage(rows, limit, (r) => ({ sortValue: r.name, id: String(r.id) }));
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
        updatedAt: new Date(),
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

    const template = tmpl[0];
    const today = todayIso();
    const nextRun = advanceDate(today, template.frequency);

    return this.db.transaction(async (tx) => {
      const entry = await this.materializeEntry(template, today, userId, tx);
      await tx
        .update(finRecurringJournalTemplates)
        .set({ lastRunDate: today, nextRunDate: nextRun })
        .where(
          and(
            eq(finRecurringJournalTemplates.id, templateId),
            eq(finRecurringJournalTemplates.orgId, orgId),
          ),
        );
      return entry;
    });
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

    // Parse and balance-check in memory FIRST, before anything is claimed. It is
    // the only per-template failure that is not a database failure, so lifting it
    // out is what lets a BATCHED run still report a per-template error count: an
    // unbalanced or malformed template is counted and dropped, and every template
    // around it still posts.
    const byOrg = new Map<string, DueTemplate[]>();
    for (const tmpl of templates) {
      let lines: RecurringLine[];
      try {
        lines = recurringLineArraySchema.parse(tmpl.lines);
        this.validateLines(lines);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to materialize recurring journal template ${tmpl.id}: ${msg}`);
        errors++;
        continue;
      }
      const group = byOrg.get(tmpl.orgId);
      if (group) group.push({ tmpl, lines });
      else byOrg.set(tmpl.orgId, [{ tmpl, lines }]);
    }

    for (const [templateOrgId, due] of byOrg) {
      for (let offset = 0; offset < due.length; offset += RUN_BATCH) {
        const batch = due.slice(offset, offset + RUN_BATCH);
        try {
          processed += await this.db.transaction((tx) =>
            this.claimAndMaterializeBatch(tx, templateOrgId, batch, today, systemUserId),
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Failed to materialize ${batch.length} recurring journal template(s) for org ${templateOrgId}: ${msg}`,
          );
          errors += batch.length;
        }
      }
    }

    return { processed, errors };
  }

  /**
   * Claim a batch of due templates and post their entries, in four statements
   * rather than four PER TEMPLATE.
   *
   * The atomicity this replaced is unchanged and is the reason the order below
   * is load-bearing. The entry and the template advance still commit together,
   * and the advance still goes FIRST as a compare-and-set on the due predicate:
   * two separate round trips lost a crash window between them, where the entry
   * committed, `nextRunDate` did not move, and the next day's sweep spawned a
   * SECOND entry for the same template — `uniq_je_idempotency` only blocks the
   * repeat while `sourceEvent` is still today's date, so the duplicate lands as
   * soon as the date rolls over. Claiming first also makes two concurrent sweeps
   * safe: the loser blocks on the row lock, re-evaluates `next_run_date <= today`
   * against the winner's committed row, matches nothing and spawns nothing.
   * A template another sweep won is simply absent from `RETURNING`, so it is
   * dropped from this batch rather than posted.
   *
   * What changed is the COUNT. The claim was one `UPDATE … RETURNING` per due
   * template inside its own transaction, and the post was a sequence upsert, an
   * entry insert and a line insert on top of that — four statements and a
   * transaction per template, which is the growing-loop database call §5.1 and
   * PRD-C072 forbid. `next_run_date` is a function of `(entryDate, frequency)`
   * alone, so the five enum values are the only distinct SET clauses a batch can
   * ever need: the claim is at most five bounded multi-key UPDATEs regardless of
   * how many templates are due, and the sequence, the entries and their lines are
   * one statement each.
   */
  private async claimAndMaterializeBatch(
    tx: Tx,
    orgId: string,
    batch: readonly DueTemplate[],
    entryDate: string,
    userId: string,
  ): Promise<number> {
    const byFrequency = new Map<string, number[]>();
    for (const { tmpl } of batch) {
      const ids = byFrequency.get(tmpl.frequency);
      if (ids) ids.push(tmpl.id);
      else byFrequency.set(tmpl.frequency, [tmpl.id]);
    }

    const claimedIds = new Set<number>();
    for (const [frequency, ids] of byFrequency) {
      const claimed = await tx
        .update(finRecurringJournalTemplates)
        .set({ lastRunDate: entryDate, nextRunDate: advanceDate(entryDate, frequency) })
        .where(
          and(
            eq(finRecurringJournalTemplates.orgId, orgId),
            inArray(finRecurringJournalTemplates.id, ids),
            eq(finRecurringJournalTemplates.isActive, true),
            lte(finRecurringJournalTemplates.nextRunDate, entryDate),
          ),
        )
        .returning({ id: finRecurringJournalTemplates.id });
      for (const row of claimed) claimedIds.add(row.id);
    }

    const won = batch.filter(({ tmpl }) => claimedIds.has(tmpl.id));
    if (won.length === 0) return 0;

    const entryNumbers = await this.allocateSequenceNumbers(orgId, entryDate, won.length, tx);

    const entries = await tx
      .insert(journalEntries)
      .values(
        won.map(({ tmpl }, index) => ({
          orgId,
          entryNumber: entryNumbers[index],
          entryDate,
          description: tmpl.name,
          sourceType: "recurring_journal",
          sourceId: String(tmpl.id),
          sourceEvent: entryDate,
          status: "DRAFT" as const,
          createdBy: userId,
        })),
      )
      .returning({ id: journalEntries.id, sourceId: journalEntries.sourceId });

    // Keyed on `sourceId`, not on position: `RETURNING` does not promise the
    // order of the VALUES list, and a batch that mismatched entry to lines would
    // post someone else's debits under this template's number.
    const entryIdBySource = new Map(entries.map((entry) => [entry.sourceId, entry.id]));

    const lineRows: (typeof journalLines.$inferInsert)[] = [];
    for (const { tmpl, lines } of won) {
      const entryId = entryIdBySource.get(String(tmpl.id));
      if (entryId === undefined)
        throw new Error(`Journal entry insert returned no row for template ${tmpl.id}`);
      lines.forEach((line, idx) => {
        lineRows.push({
          entryId,
          accountId: line.accountId,
          orgId,
          debit: decimalFromNumber(line.debit),
          credit: decimalFromNumber(line.credit),
          description: line.description ?? null,
          lineOrder: idx,
        });
      });
    }

    if (lineRows.length > 0) await tx.insert(journalLines).values(lineRows);
    return won.length;
  }

  private async materializeEntry(
    tmpl: typeof finRecurringJournalTemplates.$inferSelect,
    entryDate: string,
    userId: string,
    tx: Tx,
  ) {
    const lines = recurringLineArraySchema.parse(tmpl.lines);
    this.validateLines(lines);

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
      debit: decimalFromNumber(line.debit),
      credit: decimalFromNumber(line.credit),
      description: line.description ?? null,
      lineOrder: idx,
    }));

    await tx.insert(journalLines).values(lineRows);
    return entry;
  }

  private async nextSequenceNumber(orgId: string, entryDate: string, tx: Tx): Promise<string> {
    const [entryNumber] = await this.allocateSequenceNumbers(orgId, entryDate, 1, tx);
    if (entryNumber === undefined) throw new Error("Sequence upsert returned no rows");
    return entryNumber;
  }

  /**
   * Reserve `count` consecutive journal numbers in ONE upsert.
   *
   * The counter moves by `count` instead of by 1, and the returned `nextNumber`
   * is the value AFTER the bump, so the block this call owns is
   * `[next - count, next - 1]`. At `count = 1` that is exactly the arithmetic the
   * per-entry version did (`seq = next - 1`), which is what keeps `runNow` and
   * the single-template path byte-identical while the batch path stops paying a
   * round trip per entry.
   */
  private async allocateSequenceNumbers(
    orgId: string,
    entryDate: string,
    count: number,
    tx: Tx,
  ): Promise<string[]> {
    const inserted = await tx
      .insert(accNumberSequences)
      .values({ orgId, entityType: "journal", prefix: "JE", nextNumber: count + 1, padding: 5 })
      .onConflictDoUpdate({
        target: [accNumberSequences.orgId, accNumberSequences.entityType],
        set: { nextNumber: sql`${accNumberSequences.nextNumber} + ${count}` },
      })
      .returning({ next: accNumberSequences.nextNumber, padding: accNumberSequences.padding });

    const row = inserted[0];
    if (!row) throw new Error("Sequence upsert returned no rows");
    const pad = Number(row.padding ?? 5);
    const period = yyyymm(entryDate);
    const first = Number(row.next) - count;
    return Array.from(
      { length: count },
      (_, index) => `JE-${period}-${String(first + index).padStart(pad, "0")}`,
    );
  }

  private validateLines(lines: RecurringLine[]): void {
    const totalDebit = sumDecimals(lines.map((l) => decimalFromNumber(l.debit)));
    const totalCredit = sumDecimals(lines.map((l) => decimalFromNumber(l.credit)));
    if (compareDecimals(totalDebit, totalCredit) !== 0) {
      throw new BadRequestException(
        `Recurring journal lines are unbalanced: debit=${totalDebit} credit=${totalCredit}`,
      );
    }
  }
}
