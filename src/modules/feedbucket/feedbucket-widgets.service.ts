import { ConflictException, Inject, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { feedbucketSubmissions, feedbucketWidgets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { CreateWidgetInput, UpdateWidgetInput } from "./feedbucket.schemas";
import { isUniqueViolation } from "../../common/db/postgres-error";

@Injectable()
export class FeedbucketWidgetsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async create(orgId: string, userId: string, dto: CreateWidgetInput) {
    const publicKey = "fb_" + randomBytes(24).toString("base64url");
    try {
      const [widget] = await this.db
        .insert(feedbucketWidgets)
        .values({
          orgId,
          name: dto.name,
          publicKey,
          projectId: dto.projectId ?? null,
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
    await this.findOne(orgId, widgetId);
    const patch: Partial<typeof feedbucketWidgets.$inferInsert> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.projectId !== undefined) patch.projectId = dto.projectId;
    if (dto.allowedDomains !== undefined) patch.allowedDomains = dto.allowedDomains;
    if (dto.autoCreateTicket !== undefined) patch.autoCreateTicket = dto.autoCreateTicket;
    if (dto.aiAssistEnabled !== undefined) patch.aiAssistEnabled = dto.aiAssistEnabled;
    if (dto.defaultTicketType !== undefined) patch.defaultTicketType = dto.defaultTicketType;
    if (dto.theme !== undefined) patch.theme = dto.theme ?? null;
    if (dto.isActive !== undefined) patch.isActive = dto.isActive;

    const [updated] = await this.db
      .update(feedbucketWidgets)
      .set(patch)
      .where(and(eq(feedbucketWidgets.id, widgetId), eq(feedbucketWidgets.orgId, orgId)))
      .returning();
    return updated;
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
