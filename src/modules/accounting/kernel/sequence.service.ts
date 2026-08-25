import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { glDocumentSequences } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DocumentSeriesKind, DocumentSeriesPattern } from "../packs/pack.types";

export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface SequenceContext {
  orgId: string;
  bookId: string;
  kind: DocumentSeriesKind;
  series: DocumentSeriesPattern;
  /** Required when the pack resets the series each year; ignored otherwise. */
  fiscalYear?: { id: string; name: string };
}

/**
 * Allocates document and journal numbers.
 *
 * The increment is a single atomic upsert rather than a read-then-write, so two
 * concurrent posts cannot be handed the same number. The unique index on the
 * document table is still the last word — this makes collisions rare, the index
 * makes them impossible.
 */
@Injectable()
export class SequenceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Reserve the next number and render it through the pack's pattern.
   * Must run inside the caller's transaction so a failed post does not burn a
   * number it never used — and so the number it does use is never reissued.
   */
  async allocate(ctx: SequenceContext, tx: DbOrTx = this.db): Promise<string> {
    const resetsAnnually = ctx.series.resetEachFiscalYear;
    if (resetsAnnually && !ctx.fiscalYear) {
      throw new Error(
        `Series ${ctx.kind} resets each fiscal year but no fiscal year was supplied`,
      );
    }
    const fiscalYearId = resetsAnnually ? (ctx.fiscalYear?.id ?? null) : null;

    const [row] = await tx
      .insert(glDocumentSequences)
      .values({
        orgId: ctx.orgId,
        bookId: ctx.bookId,
        kind: ctx.kind,
        fiscalYearId,
        prefix: ctx.series.prefix,
        pattern: ctx.series.pattern,
        padding: ctx.series.padding,
        nextNumber: 2,
      })
      // Both uniques are *partial*, so the conflict target has to repeat the
      // index predicate or Postgres cannot infer which index to arbitrate on.
      .onConflictDoUpdate({
        target: fiscalYearId
          ? [glDocumentSequences.bookId, glDocumentSequences.kind, glDocumentSequences.fiscalYearId]
          : [glDocumentSequences.bookId, glDocumentSequences.kind],
        targetWhere: fiscalYearId
          ? sql`${glDocumentSequences.fiscalYearId} IS NOT NULL`
          : sql`${glDocumentSequences.fiscalYearId} IS NULL`,
        set: { nextNumber: sql`${glDocumentSequences.nextNumber} + 1` },
      })
      .returning({ nextNumber: glDocumentSequences.nextNumber });

    if (!row) throw new Error(`Could not allocate a ${ctx.kind} number`);

    // The upsert returns the *post-increment* value. A fresh row inserts 2 and
    // hands out 1; an existing row increments and hands out the value it had.
    const allocated = row.nextNumber - 1;
    return this.render(ctx, allocated);
  }

  /** `{PREFIX}/{FY}/{SEQ}` with tokens filled from the pack and fiscal year. */
  private render(ctx: SequenceContext, value: number): string {
    return ctx.series.pattern
      .replace("{PREFIX}", ctx.series.prefix)
      .replace("{FY}", ctx.fiscalYear?.name ?? "")
      .replace("{SEQ}", String(value).padStart(ctx.series.padding, "0"))
      // A continuous pattern that never had an {FY} token can still leave a
      // doubled separator if a pack is misconfigured; collapse it.
      .replace(/\/{2,}/g, "/");
  }

  /** Current value without consuming it — for settings screens only. */
  async peek(ctx: SequenceContext, tx: DbOrTx = this.db): Promise<number> {
    const fiscalYearId = ctx.series.resetEachFiscalYear ? (ctx.fiscalYear?.id ?? null) : null;
    const [row] = await tx
      .select({ nextNumber: glDocumentSequences.nextNumber })
      .from(glDocumentSequences)
      .where(
        and(
          eq(glDocumentSequences.bookId, ctx.bookId),
          eq(glDocumentSequences.kind, ctx.kind),
          fiscalYearId
            ? eq(glDocumentSequences.fiscalYearId, fiscalYearId)
            : isNull(glDocumentSequences.fiscalYearId),
        ),
      )
      .limit(1);
    return row?.nextNumber ?? 1;
  }
}
