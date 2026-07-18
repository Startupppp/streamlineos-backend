import { Inject, Injectable } from "@nestjs/common";
import { eq, and } from "drizzle-orm";
import { clientOnboardingItems, clientOnboardingTemplates, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateOnboardingItemInput, CreateTemplateInput, PatchOnboardingItemInput } from "./dto/clients.schemas";

@Injectable()
export class ClientOnboardingService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listItems(orgId: string, clientId: number | undefined) {
    const conditions = [eq(clientOnboardingItems.orgId, orgId)];
    if (clientId) conditions.push(eq(clientOnboardingItems.clientId, clientId));

    return this.db
      .select({
        id: clientOnboardingItems.id,
        orgId: clientOnboardingItems.orgId,
        clientId: clientOnboardingItems.clientId,
        templateId: clientOnboardingItems.templateId,
        title: clientOnboardingItems.title,
        description: clientOnboardingItems.description,
        assignedTo: clientOnboardingItems.assignedTo,
        dueDate: clientOnboardingItems.dueDate,
        completedAt: clientOnboardingItems.completedAt,
        completedBy: clientOnboardingItems.completedBy,
        sortOrder: clientOnboardingItems.sortOrder,
        createdAt: clientOnboardingItems.createdAt,
        updatedAt: clientOnboardingItems.updatedAt,
        assignee: { id: users.id, name: users.name },
      })
      .from(clientOnboardingItems)
      .leftJoin(users, eq(clientOnboardingItems.assignedTo, users.id))
      .where(and(...conditions))
      .orderBy(clientOnboardingItems.sortOrder, clientOnboardingItems.createdAt)
      .limit(100);
  }

  async createItem(orgId: string, input: CreateOnboardingItemInput) {
    const [item] = await this.db
      .insert(clientOnboardingItems)
      .values({
        orgId,
        clientId: input.clientId,
        title: input.title,
        description: input.description ?? null,
        assignedTo: input.assignedTo ?? null,
        dueDate: input.dueDate ?? null,
        sortOrder: input.sortOrder,
        templateId: input.templateId ?? null,
      })
      .returning();

    return item;
  }

  async updateItem(orgId: string, userId: string, itemId: number, input: PatchOnboardingItemInput) {
    const [existing] = await this.db
      .select({ id: clientOnboardingItems.id })
      .from(clientOnboardingItems)
      .where(and(eq(clientOnboardingItems.id, itemId), eq(clientOnboardingItems.orgId, orgId)))
      .limit(1);

    if (!existing) return null;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.assignedTo !== undefined) updates.assignedTo = input.assignedTo;
    if (input.dueDate !== undefined) updates.dueDate = input.dueDate;
    if (input.completedAt !== undefined) {
      updates.completedAt = input.completedAt ? new Date(input.completedAt) : null;
      updates.completedBy = input.completedAt ? userId : null;
    }

    const [updated] = await this.db
      .update(clientOnboardingItems)
      .set(updates)
      .where(and(eq(clientOnboardingItems.id, itemId), eq(clientOnboardingItems.orgId, orgId)))
      .returning();

    return updated;
  }

  async deleteItem(orgId: string, itemId: number) {
    const [existing] = await this.db
      .select({ id: clientOnboardingItems.id })
      .from(clientOnboardingItems)
      .where(and(eq(clientOnboardingItems.id, itemId), eq(clientOnboardingItems.orgId, orgId)))
      .limit(1);

    if (!existing) return null;

    await this.db.delete(clientOnboardingItems).where(and(eq(clientOnboardingItems.id, itemId), eq(clientOnboardingItems.orgId, orgId)));

    return { success: true };
  }

  listTemplates(orgId: string) {
    return this.db
      .select()
      .from(clientOnboardingTemplates)
      .where(eq(clientOnboardingTemplates.orgId, orgId))
      .limit(100);
  }

  async createTemplate(orgId: string, userId: string, input: CreateTemplateInput) {
    const [template] = await this.db
      .insert(clientOnboardingTemplates)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        isDefault: input.isDefault,
        createdBy: userId,
      })
      .returning();

    return template;
  }
}
