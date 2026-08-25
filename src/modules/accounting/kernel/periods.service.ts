import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, eq, gte, lte } from "drizzle-orm";
import { glBooks, glFiscalYears, glJournals, glPeriods } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { PackRegistry } from "../packs/pack.registry";
import { BooksService } from "./books.service";
import { fiscalYearFor, nextFiscalYear } from "./fiscal-calendar";
import type { DbOrTx } from "./sequence.service";

/**
 * Fiscal years and period locking.
 *
 * A lock is the only control the kernel offers over *when* things can be
 * posted, so unlocking is a privileged, audited act with a mandatory reason —
 * reopening a closed month is how restated numbers happen.
 */
@Injectable()
export class PeriodsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly packs: PackRegistry,
    private readonly audit: AuditService,
  ) {}

  async listFiscalYears(orgId: string, bookId: string) {
    return this.db
      .select({
        id: glFiscalYears.id,
        name: glFiscalYears.name,
        startsOn: glFiscalYears.startsOn,
        endsOn: glFiscalYears.endsOn,
        status: glFiscalYears.status,
      })
      .from(glFiscalYears)
      .where(and(eq(glFiscalYears.orgId, orgId), eq(glFiscalYears.bookId, bookId)))
      .orderBy(asc(glFiscalYears.startsOn));
  }

  async listPeriods(orgId: string, bookId: string, fiscalYearId?: string) {
    return this.db
      .select({
        id: glPeriods.id,
        fiscalYearId: glPeriods.fiscalYearId,
        name: glPeriods.name,
        startsOn: glPeriods.startsOn,
        endsOn: glPeriods.endsOn,
        sequence: glPeriods.sequence,
        status: glPeriods.status,
        lockedAt: glPeriods.lockedAt,
        lockReason: glPeriods.lockReason,
      })
      .from(glPeriods)
      .where(
        and(
          eq(glPeriods.orgId, orgId),
          eq(glPeriods.bookId, bookId),
          fiscalYearId ? eq(glPeriods.fiscalYearId, fiscalYearId) : undefined,
        ),
      )
      .orderBy(asc(glPeriods.startsOn));
  }

  /** The period a given date falls in — what the posting path asks for. */
  async periodForDate(bookId: string, date: string, tx: DbOrTx = this.db) {
    const [period] = await tx
      .select({
        id: glPeriods.id,
        name: glPeriods.name,
        status: glPeriods.status,
        fiscalYearId: glPeriods.fiscalYearId,
      })
      .from(glPeriods)
      .where(
        and(eq(glPeriods.bookId, bookId), lte(glPeriods.startsOn, date), gte(glPeriods.endsOn, date)),
      )
      .limit(1);
    return period ?? null;
  }

  /**
   * Lock a period. Earlier periods must already be locked — locking August
   * while July is open would leave a hole someone can still post into, which
   * makes the lock decorative.
   */
  async lock(orgId: string, userId: string, bookId: string, periodId: string, reason?: string) {
    const period = await this.requirePeriod(orgId, bookId, periodId);
    if (period.status === "LOCKED") {
      throw new ConflictException(`${period.name} is already locked`);
    }

    const openEarlier = await this.db
      .select({ n: count() })
      .from(glPeriods)
      .where(
        and(
          eq(glPeriods.bookId, bookId),
          eq(glPeriods.status, "OPEN"),
          lte(glPeriods.endsOn, period.startsOn),
        ),
      );
    if (Number(openEarlier[0]?.n ?? 0) > 0) {
      throw new ConflictException(
        `Lock the earlier open periods first — locking ${period.name} while an earlier one is open leaves a gap.`,
      );
    }

    const [updated] = await this.db
      .update(glPeriods)
      .set({
        status: "LOCKED",
        lockedBy: userId,
        lockedAt: new Date(),
        lockReason: reason ?? null,
      })
      .where(and(eq(glPeriods.orgId, orgId), eq(glPeriods.id, periodId)))
      .returning();

    this.audit.log({
      action: "accounting.period.locked",
      userId,
      orgId,
      resourceType: "gl_periods",
      resourceId: periodId,
      after: { name: period.name, reason: reason ?? null },
    });
    return updated;
  }

  /**
   * Reopen a locked period. Requires `accounting:periods:reopen` at the route,
   * and a reason here — this is the audit trail an auditor will ask about.
   */
  async unlock(orgId: string, userId: string, bookId: string, periodId: string, reason: string) {
    if (!reason?.trim()) {
      throw new BadRequestException("Reopening a locked period requires a reason");
    }
    const period = await this.requirePeriod(orgId, bookId, periodId);
    if (period.status !== "LOCKED") {
      throw new ConflictException(`${period.name} is not locked`);
    }

    const journals = await this.db
      .select({ n: count() })
      .from(glJournals)
      .where(eq(glJournals.periodId, periodId));

    const [updated] = await this.db
      .update(glPeriods)
      .set({ status: "OPEN", lockedBy: null, lockedAt: null, lockReason: reason.trim() })
      .where(and(eq(glPeriods.orgId, orgId), eq(glPeriods.id, periodId)))
      .returning();

    this.audit.log({
      action: "accounting.period.reopened",
      userId,
      orgId,
      resourceType: "gl_periods",
      resourceId: periodId,
      before: { status: "LOCKED" },
      after: { status: "OPEN", reason: reason.trim(), journalsInPeriod: Number(journals[0]?.n ?? 0) },
    });
    return updated;
  }

  /** Open the fiscal year following the latest one, with its twelve periods. */
  async openNextFiscalYear(orgId: string, userId: string, bookId: string) {
    const [book] = await this.db
      .select({
        fiscalYearStartMonth: glBooks.fiscalYearStartMonth,
        fiscalYearStartDay: glBooks.fiscalYearStartDay,
        localizationPack: glBooks.localizationPack,
      })
      .from(glBooks)
      .where(and(eq(glBooks.orgId, orgId), eq(glBooks.id, bookId)))
      .limit(1);
    if (!book) throw new NotFoundException("Book not found");

    const pack = this.packs.get(book.localizationPack);
    const existing = await this.listFiscalYears(orgId, bookId);

    const latest = existing.at(-1);
    const span = latest
      ? nextFiscalYear(
          { name: latest.name, startsOn: latest.startsOn, endsOn: latest.endsOn },
          pack.fiscalYearNaming,
        )
      : fiscalYearFor(
          new Date().toISOString().slice(0, 10),
          book.fiscalYearStartMonth,
          book.fiscalYearStartDay,
          pack.fiscalYearNaming,
        );

    const created = await this.books.ensureFiscalYear(orgId, bookId, span.startsOn);

    this.audit.log({
      action: "accounting.fiscal_year.opened",
      userId,
      orgId,
      resourceType: "gl_fiscal_years",
      resourceId: created.id,
      after: { name: created.name, startsOn: created.startsOn, endsOn: created.endsOn },
    });
    return created;
  }

  private async requirePeriod(orgId: string, bookId: string, periodId: string) {
    const [period] = await this.db
      .select({
        id: glPeriods.id,
        name: glPeriods.name,
        status: glPeriods.status,
        startsOn: glPeriods.startsOn,
      })
      .from(glPeriods)
      .where(
        and(
          eq(glPeriods.orgId, orgId),
          eq(glPeriods.bookId, bookId),
          eq(glPeriods.id, periodId),
        ),
      )
      .limit(1);
    if (!period) throw new NotFoundException("Period not found");
    return period;
  }
}
