import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { recordLayoutAdjustments } from "../../db/schema";
import type { RecordLayoutGroup } from "../../db/schema/common/record-layouts";
import { layoutByKey, type RecordLayoutDescription } from "./record-layout-catalog";
import {
  layoutAdjustmentSchemaFor,
  type SaveLayoutAdjustmentInput,
} from "./dto/record-layouts.schemas";

/**
 * What a read returns, matching the frontend's `LayoutAdjustment` exactly.
 *
 * The arrays are always present rather than optional, because "unset" and
 * "empty" are the same arrangement and two spellings of one state is how a
 * client ends up branching on which one it got.
 */
export interface StoredLayoutAdjustment {
  readonly layoutKey: string;
  readonly order: string[];
  readonly hidden: string[];
  readonly groups: RecordLayoutGroup[];
  readonly updatedAt: string;
}

/**
 * How often each field of a record type carries a value, over a bounded sample.
 *
 * `cap` is in the response deliberately. `sample` alone cannot tell an
 * administrator whether they are looking at every record they have or at the
 * most recent five hundred of forty thousand, and a proposal to hide a field
 * means something different in each case.
 */
export interface LayoutUsage {
  readonly sample: number;
  readonly cap: number;
  readonly filled: Record<string, number>;
  /**
   * Fields nothing on the row can be counted for — a value the API computes
   * rather than stores. Named rather than reported as zero, because zero means
   * "nobody has ever filled this in" and drives a proposal to hide it.
   */
  readonly uncounted: string[];
}

/**
 * The most rows a usage sample ever reads.
 *
 * A proposal built from the fifty rows a list happened to load is a proposal
 * about page one, so this is counted on the server — but "count every row this
 * tenant has ever created" is an unbounded scan on the busiest table in the
 * product, run from a settings screen. Five hundred of the most recent records
 * is enough for "nobody has ever put anything here", which is the only signal
 * the proposal acts on.
 */
export const USAGE_SAMPLE_CAP = 500;

@Injectable()
export class RecordLayoutsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The tenant's arrangement, or null.
   *
   * `orgId` is a parameter and never a filter the caller can influence: every
   * route takes it from `@CurrentUser()`, so there is no request shape that
   * addresses another organisation's row.
   */
  async get(orgId: string, layoutKey: string): Promise<StoredLayoutAdjustment | null> {
    const [row] = await this.db
      .select()
      .from(recordLayoutAdjustments)
      .where(
        and(
          eq(recordLayoutAdjustments.orgId, orgId),
          eq(recordLayoutAdjustments.layoutKey, layoutKey),
        ),
      )
      .limit(1);

    return row ? this.present(row) : null;
  }

  /**
   * Store an arrangement, replacing whatever was there.
   *
   * A PUT rather than a PATCH because an arrangement is one thing: an order with
   * a field missing from it is not a partial order, it is an order that leaves
   * that field where the description put it. Merging would make "remove this
   * field from my ordering" unexpressible.
   *
   * One upsert rather than a read-then-write in a transaction. The unique
   * constraint on `(org_id, layout_key)` is the serialisation point, so two
   * administrators saving at once produce one row and a last-writer-wins, rather
   * than a lost update or a duplicate key nobody handled.
   */
  async save(
    orgId: string,
    userId: string,
    layoutKey: string,
    input: SaveLayoutAdjustmentInput,
  ): Promise<StoredLayoutAdjustment> {
    const layout = this.describe(layoutKey);
    const adjustment = layoutAdjustmentSchemaFor(layout).parse(input);

    const values = {
      orgId,
      layoutKey,
      fieldOrder: [...(adjustment.order ?? [])],
      hiddenFields: [...(adjustment.hidden ?? [])],
      groups: (adjustment.groups ?? []).map((group) => ({
        title: group.title,
        fields: [...group.fields],
      })),
      updatedBy: userId,
      updatedAt: new Date(),
    };

    const [row] = await this.db
      .insert(recordLayoutAdjustments)
      .values(values)
      .onConflictDoUpdate({
        target: [recordLayoutAdjustments.orgId, recordLayoutAdjustments.layoutKey],
        set: {
          fieldOrder: values.fieldOrder,
          hiddenFields: values.hiddenFields,
          groups: values.groups,
          updatedBy: values.updatedBy,
          // Set explicitly: `$onUpdate` fires for `db.update`, not for the
          // update half of an upsert, so without this the row would keep the
          // timestamp of the first save forever.
          updatedAt: values.updatedAt,
        },
      })
      .returning();

    if (!row) throw new BadRequestException("The arrangement could not be saved.");
    return this.present(row);
  }

  /**
   * Forget the arrangement; the description renders as declared again.
   *
   * Returns null rather than 404 when there was nothing stored. "This tenant has
   * no arrangement" is the state the caller asked for, and it is the state
   * afterwards either way.
   */
  async remove(orgId: string, layoutKey: string): Promise<null> {
    this.describe(layoutKey);
    await this.db
      .delete(recordLayoutAdjustments)
      .where(
        and(
          eq(recordLayoutAdjustments.orgId, orgId),
          eq(recordLayoutAdjustments.layoutKey, layoutKey),
        ),
      );
    return null;
  }

  /**
   * Which fields this tenant actually fills in.
   *
   * Counted here because this is where the records are, and bounded because a
   * settings screen must not be able to start a full scan. The sample is the
   * most recent `USAGE_SAMPLE_CAP` rows, which is what makes "no record has ever
   * carried a value for this field" a statement about recent practice rather
   * than about a table's whole history.
   *
   * Every identifier in the generated SQL comes from `RECORD_LAYOUTS`, which is
   * a frozen literal in this repository. The only value that reaches the
   * database as data is `orgId`, bound as a parameter — `layoutKey` has already
   * been matched against the published set, so it selects a source rather than
   * becoming one.
   */
  async usage(orgId: string, layoutKey: string): Promise<LayoutUsage> {
    const layout = this.describe(layoutKey);
    const source = layout.usage;

    const uncounted = layout.fields.filter((field) => !source?.columns[field]);
    if (!source) return { sample: 0, cap: USAGE_SAMPLE_CAP, filled: {}, uncounted };

    const counted = layout.fields.filter((field) => source.columns[field]);

    const projected = counted.map((field, index) =>
      sql.raw(
        `NULLIF(NULLIF(NULLIF(btrim((${source.columns[field]})::text), ''), '{}'), '[]') AS "f${index}"`,
      ),
    );
    const aggregated = counted.map((_field, index) =>
      sql.raw(`count(s."f${index}")::int AS "f${index}"`),
    );

    const predicates = [
      sql`${sql.raw(`"${source.table}"."${source.orgColumn}"`)} = ${orgId}`,
      ...source.filters.map((filter) => sql.raw(`(${filter})`)),
    ];

    const rows = await this.db.execute(sql`
      SELECT count(*)::int AS "sample"${aggregated.length ? sql`, ` : sql``}${sql.join(aggregated, sql`, `)}
      FROM (
        SELECT ${sql.join(projected.length ? projected : [sql.raw("1 AS unused")], sql`, `)}
        FROM ${sql.raw(`"${source.table}"`)}
        WHERE ${sql.join(predicates, sql` AND `)}
        ORDER BY ${sql.raw(`"${source.table}"."${source.orderColumn}"`)} DESC NULLS LAST
        LIMIT ${USAGE_SAMPLE_CAP}
      ) s`);

    const [row] = rows as unknown as Array<Record<string, number | null>>;
    const filled: Record<string, number> = {};
    counted.forEach((field, index) => {
      filled[field] = Number(row?.[`f${index}`] ?? 0);
    });

    return {
      sample: Number(row?.["sample"] ?? 0),
      cap: USAGE_SAMPLE_CAP,
      filled,
      uncounted,
    };
  }

  /** The published description, or a 400 naming what a layout key may be. */
  private describe(layoutKey: string): RecordLayoutDescription {
    const layout = layoutByKey(layoutKey);
    if (!layout) throw new BadRequestException(`Unknown record layout "${layoutKey}".`);
    return layout;
  }

  private present(row: typeof recordLayoutAdjustments.$inferSelect): StoredLayoutAdjustment {
    return {
      layoutKey: row.layoutKey,
      order: row.fieldOrder ?? [],
      hidden: row.hiddenFields ?? [],
      groups: row.groups ?? [],
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
