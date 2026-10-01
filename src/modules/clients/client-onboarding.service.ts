import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  clientOnboardingItems,
  clientOnboardingTemplateItems,
  clientOnboardingTemplates,
  organizationMembers,
  users,
} from "../../db/schema";
import { clientPartyMap } from "../../db/schema/party";
import type { CreateOnboardingItemInput, CreateTemplateInput, PatchOnboardingItemInput } from "./dto/clients.schemas";

export type ClientOnboardingActor = { userId: string; membershipId: number | null };

const BUILT_IN_CHECKLIST = [
  { title: "Confirm client details", description: "Verify the primary client information.", sortOrder: 0 },
  { title: "Agree onboarding goals", description: "Record the outcomes and success criteria.", sortOrder: 1 },
  { title: "Schedule kickoff", description: "Book the client kickoff meeting.", sortOrder: 2 },
] as const;

@Injectable()
export class ClientOnboardingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  listItems(orgId: string, clientId: number | undefined) {
    const conditions = [eq(clientOnboardingItems.orgId, orgId), isNull(clientOnboardingItems.archivedAt)];
    if (clientId) conditions.push(eq(clientOnboardingItems.clientId, clientId));
    return this.db.select({
      id: clientOnboardingItems.id,
      orgId: clientOnboardingItems.orgId,
      clientId: clientOnboardingItems.clientId,
      templateId: clientOnboardingItems.templateId,
      title: clientOnboardingItems.title,
      description: clientOnboardingItems.description,
      assignedTo: clientOnboardingItems.assignedTo,
      assignedToMembershipId: clientOnboardingItems.assignedToMembershipId,
      dueDate: clientOnboardingItems.dueDate,
      completedAt: clientOnboardingItems.completedAt,
      completedBy: clientOnboardingItems.completedBy,
      completedByMembershipId: clientOnboardingItems.completedByMembershipId,
      sortOrder: clientOnboardingItems.sortOrder,
      createdAt: clientOnboardingItems.createdAt,
      updatedAt: clientOnboardingItems.updatedAt,
      assignee: { id: users.id, name: users.name },
    }).from(clientOnboardingItems)
      .leftJoin(users, eq(clientOnboardingItems.assignedTo, users.id))
      .where(and(...conditions))
      .orderBy(clientOnboardingItems.sortOrder, clientOnboardingItems.createdAt)
      .limit(100);
  }

  async startForClient(
    orgId: string,
    clientId: number,
    actor: ClientOnboardingActor,
    executor: Db = this.db,
  ): Promise<void> {
    const [template] = await executor.select({ id: clientOnboardingTemplates.id })
      .from(clientOnboardingTemplates)
      .where(and(eq(clientOnboardingTemplates.orgId, orgId), eq(clientOnboardingTemplates.isDefault, true)))
      .limit(1);
    const definitions = template
      ? await executor.select({
        title: clientOnboardingTemplateItems.title,
        description: clientOnboardingTemplateItems.description,
        sortOrder: clientOnboardingTemplateItems.sortOrder,
      }).from(clientOnboardingTemplateItems)
        .where(and(eq(clientOnboardingTemplateItems.orgId, orgId), eq(clientOnboardingTemplateItems.templateId, template.id)))
        .orderBy(asc(clientOnboardingTemplateItems.sortOrder), asc(clientOnboardingTemplateItems.id))
      : BUILT_IN_CHECKLIST;
    const steps = definitions.length > 0 ? definitions : BUILT_IN_CHECKLIST;
    await executor.insert(clientOnboardingItems).values(steps.map((step) => ({
      orgId,
      clientId,
      templateId: template?.id ?? null,
      title: step.title,
      description: step.description,
      sortOrder: step.sortOrder,
    })));
    this.audit.log({
      action: "client.onboarding.started",
      userId: actor.userId,
      actorMembershipId: actor.membershipId,
      orgId,
      resourceType: "client",
      resourceId: String(clientId),
      metadata: { templateId: template?.id ?? null, itemCount: steps.length },
    });
  }

  async createItem(orgId: string, actor: ClientOnboardingActor, input: CreateOnboardingItemInput) {
    await this.assertClient(orgId, input.clientId);
    const assignedToMembershipId = input.assignedTo ? await this.resolveActiveMembership(orgId, input.assignedTo) : null;
    const [item] = await this.db.insert(clientOnboardingItems).values({
      orgId,
      clientId: input.clientId,
      title: input.title,
      description: input.description ?? null,
      assignedTo: input.assignedTo ?? null,
      assignedToMembershipId,
      dueDate: input.dueDate ?? null,
      sortOrder: input.sortOrder,
      templateId: input.templateId ?? null,
    }).returning();
    this.audit.log({
      action: "client.onboarding.item.created",
      userId: actor.userId,
      actorMembershipId: actor.membershipId,
      orgId,
      resourceType: "client_onboarding_item",
      resourceId: item ? String(item.id) : null,
    });
    return item;
  }

  async updateItem(orgId: string, actor: ClientOnboardingActor, itemId: number, input: PatchOnboardingItemInput) {
    const updates: Partial<typeof clientOnboardingItems.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.assignedTo !== undefined) {
      updates.assignedTo = input.assignedTo;
      updates.assignedToMembershipId = input.assignedTo ? await this.resolveActiveMembership(orgId, input.assignedTo) : null;
    }
    if (input.dueDate !== undefined) updates.dueDate = input.dueDate;
    if (input.completedAt !== undefined) {
      updates.completedAt = input.completedAt ? new Date(input.completedAt) : null;
      updates.completedBy = input.completedAt ? actor.userId : null;
      updates.completedByMembershipId = input.completedAt ? actor.membershipId : null;
    }
    const [updated] = await this.db.update(clientOnboardingItems).set(updates).where(and(
      eq(clientOnboardingItems.id, itemId),
      eq(clientOnboardingItems.orgId, orgId),
      isNull(clientOnboardingItems.archivedAt),
    )).returning();
    if (updated) this.audit.log({
      action: "client.onboarding.item.updated",
      userId: actor.userId,
      actorMembershipId: actor.membershipId,
      orgId,
      resourceType: "client_onboarding_item",
      resourceId: String(itemId),
    });
    return updated ?? null;
  }

  async archiveItem(orgId: string, itemId: number, actor: ClientOnboardingActor) {
    const [archived] = await this.db.update(clientOnboardingItems).set({
      archivedAt: new Date(),
      archivedBy: actor.userId,
      archivedByMembershipId: actor.membershipId,
      updatedAt: new Date(),
    }).where(and(
      eq(clientOnboardingItems.id, itemId),
      eq(clientOnboardingItems.orgId, orgId),
      isNull(clientOnboardingItems.archivedAt),
    )).returning({ id: clientOnboardingItems.id });
    if (!archived) return null;
    this.audit.log({
      action: "client.onboarding.item.archived",
      userId: actor.userId,
      actorMembershipId: actor.membershipId,
      orgId,
      resourceType: "client_onboarding_item",
      resourceId: String(itemId),
    });
    return { success: true };
  }

  listTemplates(orgId: string) {
    return this.db.select().from(clientOnboardingTemplates).where(eq(clientOnboardingTemplates.orgId, orgId)).limit(100);
  }

  async createTemplate(orgId: string, actor: ClientOnboardingActor, input: CreateTemplateInput) {
    return this.db.transaction(async (tx) => {
      if (input.isDefault) await tx.update(clientOnboardingTemplates).set({ isDefault: false })
        .where(and(eq(clientOnboardingTemplates.orgId, orgId), eq(clientOnboardingTemplates.isDefault, true)));
      const [template] = await tx.insert(clientOnboardingTemplates).values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        isDefault: input.isDefault,
        createdBy: actor.userId,
        createdByMembershipId: actor.membershipId,
      }).returning();
      if (!template) throw new Error("Failed to create Client onboarding template");
      await tx.insert(clientOnboardingTemplateItems).values(input.items.map((item, sortOrder) => ({
        orgId,
        templateId: template.id,
        title: item.title,
        description: item.description ?? null,
        sortOrder,
      })));
      this.audit.log({
        action: "client.onboarding.template.created",
        userId: actor.userId,
        actorMembershipId: actor.membershipId,
        orgId,
        resourceType: "client_onboarding_template",
        resourceId: String(template.id),
      });
      return template;
    });
  }

  private async assertClient(orgId: string, clientId: number): Promise<void> {
    const [client] = await this.db.select({ id: clientPartyMap.clientId }).from(clientPartyMap)
      .where(and(eq(clientPartyMap.organizationId, orgId), eq(clientPartyMap.clientId, clientId))).limit(1);
    if (!client) throw new BadRequestException("Client does not belong to this organization");
  }

  private async resolveActiveMembership(orgId: string, userId: string): Promise<number> {
    const [membership] = await this.db.select({ id: organizationMembers.id }).from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId), eq(organizationMembers.status, "ACTIVE")))
      .limit(1);
    if (!membership) throw new BadRequestException("Assignee is not an active organization member");
    return membership.id;
  }
}
