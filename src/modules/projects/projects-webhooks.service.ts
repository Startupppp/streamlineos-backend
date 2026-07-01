import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, eq, desc } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { projectWebhooks, webhookDeliveries } from "../../db/schema/projects/tasks";
import type { CreateWebhookInput } from "./dto/webhook.schemas";

@Injectable()
export class ProjectsWebhooksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listWebhooks(orgId: string, projectId: number) {
    return this.db
      .select()
      .from(projectWebhooks)
      .where(and(eq(projectWebhooks.orgId, orgId), eq(projectWebhooks.projectId, projectId)))
      .orderBy(desc(projectWebhooks.createdAt));
  }

  async createWebhook(orgId: string, projectId: number, createdBy: string, data: CreateWebhookInput) {
    const [webhook] = await this.db
      .insert(projectWebhooks)
      .values({ orgId, projectId, createdBy, url: data.url, events: data.events, secret: data.secret ?? null })
      .returning();
    return webhook;
  }

  async deleteWebhook(orgId: string, webhookId: number) {
    const [deleted] = await this.db
      .delete(projectWebhooks)
      .where(and(eq(projectWebhooks.id, webhookId), eq(projectWebhooks.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Webhook not found");
  }

  listDeliveries(webhookId: number) {
    return this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.deliveredAt))
      .limit(20);
  }
}
