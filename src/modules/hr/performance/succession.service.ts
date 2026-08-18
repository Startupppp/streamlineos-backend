import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { eq, and, desc, lt, or } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrSuccessionPlans } from "../../../db/schema/hr/succession";
import type { SuccessionListInput } from "./dto/succession.schemas";
import { decodeTimestampCursor, encodeTimestampCursor } from "./cursor-pagination";

@Injectable()
export class SuccessionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, query: SuccessionListInput) {
    const cursor = query.cursor ? decodeTimestampCursor(query.cursor) : null;
    const rows = await this.db
      .select()
      .from(hrSuccessionPlans)
      .where(and(
        eq(hrSuccessionPlans.orgId, orgId),
        cursor
          ? or(
              lt(hrSuccessionPlans.createdAt, cursor.createdAt),
              and(
                eq(hrSuccessionPlans.createdAt, cursor.createdAt),
                lt(hrSuccessionPlans.id, cursor.recordId),
              ),
            )
          : undefined,
      ))
      .orderBy(desc(hrSuccessionPlans.createdAt), desc(hrSuccessionPlans.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last
        ? encodeTimestampCursor({ createdAt: last.createdAt, recordId: last.id })
        : null,
    };
  }

  async create(
    orgId: string,
    createdBy: string,
    data: {
      roleName: string;
      jobRoleId?: number | null;
      incumbentId?: string | null;
      successorId: string;
      readiness: "ready_now" | "1_2_years" | "3_plus";
      note?: string | null;
    },
  ) {
    const [created] = await this.db
      .insert(hrSuccessionPlans)
      .values({ orgId, createdBy, ...data })
      .returning();
    return created;
  }

  async update(
    orgId: string,
    id: number,
    data: Partial<{
      roleName: string;
      jobRoleId: number | null;
      incumbentId: string | null;
      successorId: string;
      readiness: "ready_now" | "1_2_years" | "3_plus";
      note: string | null;
    }>,
  ) {
    const existing = await this.db
      .select({ id: hrSuccessionPlans.id })
      .from(hrSuccessionPlans)
      .where(and(eq(hrSuccessionPlans.id, id), eq(hrSuccessionPlans.orgId, orgId)))
      .limit(1);
    if (!existing.length) throw new NotFoundException("Succession plan not found");

    const [updated] = await this.db
      .update(hrSuccessionPlans)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(hrSuccessionPlans.id, id), eq(hrSuccessionPlans.orgId, orgId)))
      .returning();
    return updated;
  }

  async remove(orgId: string, id: number) {
    const existing = await this.db
      .select({ id: hrSuccessionPlans.id })
      .from(hrSuccessionPlans)
      .where(and(eq(hrSuccessionPlans.id, id), eq(hrSuccessionPlans.orgId, orgId)))
      .limit(1);
    if (!existing.length) throw new NotFoundException("Succession plan not found");
    await this.db.delete(hrSuccessionPlans).where(and(eq(hrSuccessionPlans.id, id), eq(hrSuccessionPlans.orgId, orgId)));
    return { success: true };
  }
}
