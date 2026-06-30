import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, and, isNull } from "drizzle-orm";
import { notificationTemplates } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type {
  CreateTemplateInput,
  UpdateTemplateInput,
  PreviewTemplateInput,
  TestSendTemplateInput,
  ListTemplatesInput,
} from "./dto/template.schemas";

@Injectable()
export class NotificationTemplatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  list(orgId: string, filters: ListTemplatesInput) {
    const key = `notification-templates:list:${orgId}:${JSON.stringify(filters)}`;
    return this.cache.cached(
      key,
      () => this.queryTemplates(orgId, filters),
      CACHE_TTL.SHORT,
    );
  }

  private queryTemplates(orgId: string, filters: ListTemplatesInput) {
    return this.db.query.notificationTemplates.findMany({
      where: and(
        eq(notificationTemplates.orgId, orgId),
        filters.channel ? eq(notificationTemplates.channel, filters.channel) : undefined,
        filters.category ? eq(notificationTemplates.category, filters.category) : undefined,
        filters.isActive !== undefined
          ? eq(notificationTemplates.isActive, filters.isActive)
          : undefined,
      ),
      orderBy: (t, { desc }) => [desc(t.updatedAt)],
    });
  }

  async findOne(orgId: string, id: number) {
    const template = await this.db.query.notificationTemplates.findFirst({
      where: and(
        eq(notificationTemplates.id, id),
        eq(notificationTemplates.orgId, orgId),
      ),
    });
    if (!template) {
      throw new NotFoundException(`Template ${id} not found`);
    }
    return template;
  }

  async create(orgId: string, userId: string, dto: CreateTemplateInput) {
    const [created] = await this.db
      .insert(notificationTemplates)
      .values({
        orgId,
        templateKey: dto.templateKey,
        name: dto.name,
        channel: dto.channel,
        category: dto.category,
        locale: dto.locale,
        subject: dto.subject,
        body: dto.body,
        variables: dto.variables ?? [],
        createdBy: userId,
      })
      .returning();
    await this.cache.del(`notification-templates:list:${orgId}`);
    return created;
  }

  async update(orgId: string, _userId: string, id: number, dto: UpdateTemplateInput) {
    const existing = await this.findOne(orgId, id);
    const [updated] = await this.db
      .update(notificationTemplates)
      .set({
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.channel !== undefined && { channel: dto.channel }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.locale !== undefined && { locale: dto.locale }),
        ...(dto.subject !== undefined && { subject: dto.subject }),
        ...(dto.body !== undefined && { body: dto.body }),
        ...(dto.variables !== undefined && { variables: dto.variables }),
        version: existing.version + 1,
      })
      .where(
        and(
          eq(notificationTemplates.id, id),
          eq(notificationTemplates.orgId, orgId),
        ),
      )
      .returning();
    await this.cache.del(`notification-templates:list:${orgId}`);
    return updated;
  }

  async remove(orgId: string, id: number) {
    await this.findOne(orgId, id);
    await this.db
      .update(notificationTemplates)
      .set({ isActive: false })
      .where(
        and(
          eq(notificationTemplates.id, id),
          eq(notificationTemplates.orgId, orgId),
        ),
      );
    await this.cache.del(`notification-templates:list:${orgId}`);
    return { success: true };
  }

  async preview(orgId: string, id: number, dto: PreviewTemplateInput) {
    const template = await this.findOne(orgId, id);
    const rendered = this.renderTemplate(template.body, dto.variables);
    const renderedSubject = template.subject
      ? this.renderTemplate(template.subject, dto.variables)
      : undefined;
    return {
      subject: renderedSubject,
      body: rendered,
      channel: template.channel,
      templateKey: template.templateKey,
    };
  }

  async testSend(orgId: string, userId: string, id: number, dto: TestSendTemplateInput) {
    const template = await this.findOne(orgId, id);
    const rendered = this.renderTemplate(template.body, dto.variables);
    const renderedSubject = template.subject
      ? this.renderTemplate(template.subject, dto.variables)
      : undefined;
    return {
      success: true,
      recipientId: dto.recipientId,
      channel: template.channel,
      subject: renderedSubject,
      body: rendered,
      sentAt: new Date().toISOString(),
    };
  }

  private renderTemplate(template: string, variables: Record<string, string>): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
      const trimmed = key.trim();
      return variables[trimmed] ?? `{{${trimmed}}}`;
    });
  }
}
