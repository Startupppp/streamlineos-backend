import { BadRequestException, ConflictException, Inject, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { feedbucketSubmissions, feedbucketWidgets, type FeedbucketAssigneeRules } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { CreateWidgetInput, UpdateWidgetInput } from "./feedbucket.schemas";
import { isUniqueViolation } from "../../common/db/postgres-error";
import { resolveOrganizationActorsByUserIds } from "../../common/organization/organization-actor";

const ASSIGNEE_RULE_TYPES = ["bug", "idea", "feature", "question", "praise", "other"] as const;

@Injectable()
export class FeedbucketWidgetsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async resolveAssigneeIds(
    orgId: string,
    defaultAssigneeId: string | null | undefined,
    assigneeRules: Partial<Record<(typeof ASSIGNEE_RULE_TYPES)[number], string>> | null | undefined,
  ): Promise<{ defaultAssigneeMembershipId: number | null; assigneeRules: FeedbucketAssigneeRules | null }> {
    const ruleEntries: [(typeof ASSIGNEE_RULE_TYPES)[number], string][] = [];
    for (const type of ASSIGNEE_RULE_TYPES) {
      const userId = assigneeRules?.[type];
      if (userId) ruleEntries.push([type, userId]);
    }
    const userIds = [
      ...(defaultAssigneeId ? [defaultAssigneeId] : []),
      ...ruleEntries.map(([, userId]) => userId),
    ];
    const actorMap = await resolveOrganizationActorsByUserIds(this.db, orgId, userIds);
    for (const userId of userIds) {
      if (!actorMap.has(userId))
        throw new BadRequestException(`${userId} is not an active member of this organization`);
    }
    const resolvedRules: FeedbucketAssigneeRules = {};
    for (const [type, userId] of ruleEntries) {
      const actor = actorMap.get(userId);
      if (actor) resolvedRules[type] = actor.membershipId;
    }
    const defaultActor = defaultAssigneeId ? actorMap.get(defaultAssigneeId) : undefined;
    return {
      defaultAssigneeMembershipId: defaultActor ? defaultActor.membershipId : null,
      assigneeRules: ruleEntries.length > 0 ? resolvedRules : null,
    };
  }

  async create(orgId: string, userId: string, dto: CreateWidgetInput) {
    const publicKey = "fb_" + randomBytes(24).toString("base64url");
    const { defaultAssigneeMembershipId, assigneeRules } = await this.resolveAssigneeIds(
      orgId,
      dto.defaultAssigneeId,
      dto.assigneeRules,
    );
    try {
      const [widget] = await this.db
        .insert(feedbucketWidgets)
        .values({
          orgId,
          name: dto.name,
          publicKey,
          projectId: dto.projectId ?? null,
          defaultProjectId: dto.defaultProjectId ?? null,
          defaultAssigneeMembershipId,
          assigneeRules,
          allowedDomains: dto.allowedDomains ?? [],
          autoCreateTicket: dto.autoCreateTicket ?? false,
          aiAssistEnabled: dto.aiAssistEnabled ?? false,
          defaultTicketType: dto.defaultTicketType ?? "BUG",
          theme: dto.theme ?? null,
          createdBy: userId,
        })
        .returning({ id: feedbucketWidgets.id });
      if (!widget) throw new InternalServerErrorException("Widget not found after creation");
      return this.findOne(orgId, widget.id);
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("Widget key conflict, please try again");
      }
      throw error;
    }
  }

  async list(orgId: string) {
    const widgets = await this.db.query.feedbucketWidgets.findMany({
      where: and(eq(feedbucketWidgets.orgId, orgId), isNull(feedbucketWidgets.deletedAt)),
      with: { project: true },
      orderBy: (w, { desc }) => [desc(w.createdAt)],
    });

    if (widgets.length === 0) return [];

    const widgetIds = widgets.map((w) => w.id);

    const counts = await this.db
      .select({
        widgetId: feedbucketSubmissions.widgetId,
        total: count(),
        open: sql<number>`COUNT(*) FILTER (WHERE ${feedbucketSubmissions.status} = 'open')`,
      })
      .from(feedbucketSubmissions)
      .where(
        and(
          eq(feedbucketSubmissions.orgId, orgId),
          isNull(feedbucketSubmissions.deletedAt),
          inArray(feedbucketSubmissions.widgetId, widgetIds),
        ),
      )
      .groupBy(feedbucketSubmissions.widgetId);

    const countMap = new Map(counts.map((c) => [c.widgetId, c]));

    return widgets.map((w) => {
      const c = countMap.get(w.id);
      return { ...w, submissionCount: Number(c?.total ?? 0), openCount: Number(c?.open ?? 0) };
    });
  }

  async findOne(orgId: string, widgetId: number) {
    const widget = await this.db.query.feedbucketWidgets.findFirst({
      where: and(
        eq(feedbucketWidgets.id, widgetId),
        eq(feedbucketWidgets.orgId, orgId),
        isNull(feedbucketWidgets.deletedAt),
      ),
      with: { project: true },
    });
    if (!widget) throw new NotFoundException("Widget not found");
    return widget;
  }

  async update(orgId: string, widgetId: number, dto: UpdateWidgetInput) {
    const patch: Partial<typeof feedbucketWidgets.$inferInsert> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.projectId !== undefined) patch.projectId = dto.projectId;
    if (dto.defaultProjectId !== undefined) patch.defaultProjectId = dto.defaultProjectId;
    if (dto.defaultAssigneeId !== undefined || dto.assigneeRules !== undefined) {
      const resolved = await this.resolveAssigneeIds(orgId, dto.defaultAssigneeId, dto.assigneeRules);
      if (dto.defaultAssigneeId !== undefined) patch.defaultAssigneeMembershipId = resolved.defaultAssigneeMembershipId;
      if (dto.assigneeRules !== undefined) patch.assigneeRules = resolved.assigneeRules;
    }
    if (dto.allowedDomains !== undefined) patch.allowedDomains = dto.allowedDomains;
    if (dto.autoCreateTicket !== undefined) patch.autoCreateTicket = dto.autoCreateTicket;
    if (dto.aiAssistEnabled !== undefined) patch.aiAssistEnabled = dto.aiAssistEnabled;
    if (dto.defaultTicketType !== undefined) patch.defaultTicketType = dto.defaultTicketType;
    if (dto.theme !== undefined) patch.theme = dto.theme ?? null;
    if (dto.isActive !== undefined) patch.isActive = dto.isActive;

    const [updated] = await this.db
      .update(feedbucketWidgets)
      .set(patch)
      .where(
        and(
          eq(feedbucketWidgets.id, widgetId),
          eq(feedbucketWidgets.orgId, orgId),
          isNull(feedbucketWidgets.deletedAt),
        ),
      )
      .returning({ id: feedbucketWidgets.id });
    if (!updated) throw new NotFoundException("Widget not found");
    return this.findOne(orgId, widgetId);
  }

  async softDelete(orgId: string, widgetId: number) {
    await this.findOne(orgId, widgetId);
    await this.db
      .update(feedbucketWidgets)
      .set({ deletedAt: new Date() })
      .where(and(eq(feedbucketWidgets.id, widgetId), eq(feedbucketWidgets.orgId, orgId)));
  }

  async rotateKey(orgId: string, widgetId: number) {
    await this.findOne(orgId, widgetId);
    const newKey = "fb_" + randomBytes(24).toString("base64url");
    await this.db
      .update(feedbucketWidgets)
      .set({ publicKey: newKey, updatedAt: new Date() })
      .where(and(eq(feedbucketWidgets.id, widgetId), eq(feedbucketWidgets.orgId, orgId)));
    return { publicKey: newKey };
  }
}
