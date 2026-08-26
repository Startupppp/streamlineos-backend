import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { recordLayoutAdjustments, type LayoutGroup } from "../../db/schema";
import type { LayoutAdjustmentInput } from "./dto/layout.schemas";

/**
 * A tenant's arrangement of a record type, read and written.
 *
 * Reading is not privileged and writing is: an arrangement carries no record
 * data, only field names the layout description already publishes, so every
 * member has to read their tenant's in order to render anything at all.
 * Rearranging it is administration.
 */

export interface LayoutAdjustment {
  readonly layoutKey: string;
  readonly order?: string[];
  readonly hidden?: string[];
  readonly groups?: readonly LayoutGroup[];
  readonly updatedAt: string;
}

/** How often each field of a record type carries a value, tenant-wide. */
export interface LayoutUsage {
  readonly sample: number;
  readonly filled: Record<string, number>;
}

@Injectable()
export class RecordLayoutsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async get(organizationId: string, layoutKey: string): Promise<LayoutAdjustment | null> {
    const [row] = await this.db
      .select({
        layoutKey: recordLayoutAdjustments.layoutKey,
        order: recordLayoutAdjustments.order,
        hidden: recordLayoutAdjustments.hidden,
        groups: recordLayoutAdjustments.groups,
        updatedAt: recordLayoutAdjustments.updatedAt,
      })
      .from(recordLayoutAdjustments)
      .where(
        and(
          eq(recordLayoutAdjustments.organizationId, organizationId),
          eq(recordLayoutAdjustments.layoutKey, layoutKey),
        ),
      )
      .limit(1);

    // Absent is a value, not an error. A tenant that has never arranged anything
    // is the common case, and every record surface reads this on load.
    if (!row) return null;

    return {
      layoutKey: row.layoutKey,
      ...(row.order ? { order: row.order } : {}),
      ...(row.hidden ? { hidden: row.hidden } : {}),
      ...(row.groups ? { groups: row.groups } : {}),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Upsert, because a tenant has exactly one arrangement per type.
   *
   * Keyed on the tenant and the layout, so a concurrent save from two
   * administrators is last-writer-wins on one row rather than two rows whose
   * effective layout depends on which the next read happened to see.
   */
  async save(
    organizationId: string,
    layoutKey: string,
    input: LayoutAdjustmentInput,
  ): Promise<LayoutAdjustment> {
    const values = {
      order: input.order ? [...input.order] : null,
      hidden: input.hidden ? [...input.hidden] : null,
      groups: input.groups
        ? input.groups.map((group) => ({ title: group.title, fields: [...group.fields] }))
        : null,
    };

    const [row] = await this.db
      .insert(recordLayoutAdjustments)
      .values({ organizationId, layoutKey, ...values })
      .onConflictDoUpdate({
        target: [recordLayoutAdjustments.organizationId, recordLayoutAdjustments.layoutKey],
        set: { ...values, updatedAt: new Date() },
      })
      .returning({
        layoutKey: recordLayoutAdjustments.layoutKey,
        order: recordLayoutAdjustments.order,
        hidden: recordLayoutAdjustments.hidden,
        groups: recordLayoutAdjustments.groups,
        updatedAt: recordLayoutAdjustments.updatedAt,
      });

    return {
      layoutKey: row!.layoutKey,
      ...(row!.order ? { order: row!.order } : {}),
      ...(row!.hidden ? { hidden: row!.hidden } : {}),
      ...(row!.groups ? { groups: row!.groups } : {}),
      updatedAt: row!.updatedAt.toISOString(),
    };
  }

  /**
   * Reverting is a delete, not an empty arrangement.
   *
   * Storing `{order: [], hidden: []}` would mean "the tenant arranged this type
   * to have nothing arranged", which reads identically to the default and then
   * has to be special-cased at every render.
   */
  async reset(organizationId: string, layoutKey: string): Promise<void> {
    await this.db
      .delete(recordLayoutAdjustments)
      .where(
        and(
          eq(recordLayoutAdjustments.organizationId, organizationId),
          eq(recordLayoutAdjustments.layoutKey, layoutKey),
        ),
      );
  }
}
