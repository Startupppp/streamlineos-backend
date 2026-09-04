import { Inject, Injectable } from "@nestjs/common";
import { eq, and, asc } from "drizzle-orm";
import { playbookEntries } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { PlaybookCreateInput, PlaybookUpdateInput } from "./dto/sales.schemas";

/**
 * The sales playbook: an org-owned, ordered library of plays. It is a separate
 * entity from commissions and quotas — it carries no money, no approval state and
 * no scope resolution — so it owns its own service rather than sharing
 * `SalesService`'s commission/quota surface and its AccessService dependency.
 */
@Injectable()
export class SalesPlaybookService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listPlaybook(orgId: string) {
    return this.db
      .select()
      .from(playbookEntries)
      .where(eq(playbookEntries.orgId, orgId))
      .orderBy(asc(playbookEntries.sortOrder), asc(playbookEntries.id));
  }

  async createPlaybookEntry(orgId: string, createdBy: string, input: PlaybookCreateInput) {
    const [entry] = await this.db
      .insert(playbookEntries)
      .values({
        orgId,
        title: input.title,
        category: input.category?.trim() || null,
        content: input.content ?? "",
        sortOrder: input.sortOrder ?? 0,
        createdBy,
      })
      .returning();

    return entry;
  }

  async updatePlaybookEntry(orgId: string, entryId: number, input: PlaybookUpdateInput) {
    const values: Partial<typeof playbookEntries.$inferInsert> = {};
    if (input.title !== undefined) values.title = input.title;
    if (input.category !== undefined) values.category = input.category?.trim() || null;
    if (input.content !== undefined) values.content = input.content;
    if (input.sortOrder !== undefined) values.sortOrder = input.sortOrder;

    const [updated] = await this.db
      .update(playbookEntries)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(playbookEntries.id, entryId), eq(playbookEntries.orgId, orgId)))
      .returning();

    if (!updated) return null;
    return updated;
  }

  async removePlaybookEntry(orgId: string, entryId: number) {
    const [deleted] = await this.db
      .delete(playbookEntries)
      .where(and(eq(playbookEntries.id, entryId), eq(playbookEntries.orgId, orgId)))
      .returning();

    if (!deleted) return null;
    return { success: true };
  }
}
