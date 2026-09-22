import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, eq, desc } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { projectWebhooks, webhookDeliveries } from "../../../db/schema/build/tasks";
import type { CreateWebhookInput } from "./dto/webhook.schemas";
import { generateWebhookSecret } from "./projects-webhooks-dispatch.service";
import { assertProjectInOrg } from "./project-access";

@Injectable()
export class ProjectsWebhooksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listWebhooks(orgId: string, projectId: number) {
    await assertProjectInOrg(this.db, orgId, projectId);
    const rows = await this.db
      .select({
        id: projectWebhooks.id,
        orgId: projectWebhooks.orgId,
        projectId: projectWebhooks.projectId,
        url: projectWebhooks.url,
        events: projectWebhooks.events,
        isActive: projectWebhooks.isActive,
        createdAt: projectWebhooks.createdAt,
      })
      .from(projectWebhooks)
      .where(and(eq(projectWebhooks.orgId, orgId), eq(projectWebhooks.projectId, projectId)))
      .orderBy(desc(projectWebhooks.createdAt));
    return rows;
  }

  async createWebhook(orgId: string, projectId: number, createdBy: string, data: CreateWebhookInput) {
    // `listWebhooks` above already resolves the project; this did not, so a `:projectId` belonging
    // to another organisation reached the INSERT and the composite tenant FK (org_id, project_id)
    // refused it with an uncaught 23503 — a 500 where the contract requires 404.
    await assertProjectInOrg(this.db, orgId, projectId);
    const secret = data.secret ?? generateWebhookSecret();
    const [webhook] = await this.db
      .insert(projectWebhooks)
      .values({ orgId, projectId, createdBy, url: data.url, events: data.events, secret })
      .returning({
        id: projectWebhooks.id,
        orgId: projectWebhooks.orgId,
        projectId: projectWebhooks.projectId,
        url: projectWebhooks.url,
        events: projectWebhooks.events,
        isActive: projectWebhooks.isActive,
        createdAt: projectWebhooks.createdAt,
      });
    return webhook;
  }

  async deleteWebhook(orgId: string, projectId: number, webhookId: number) {
    await this.assertWebhookOwnership(orgId, projectId, webhookId);
    const [deleted] = await this.db
      .delete(projectWebhooks)
      .where(
        and(
          eq(projectWebhooks.id, webhookId),
          eq(projectWebhooks.projectId, projectId),
          eq(projectWebhooks.orgId, orgId),
        ),
      )
      .returning();
    if (!deleted) throw new NotFoundException("Webhook not found");
  }

  async assertWebhookOwnership(orgId: string, projectId: number, webhookId: number): Promise<void> {
    const row = await this.db
      .select({ id: projectWebhooks.id })
      .from(projectWebhooks)
      .where(
        and(
          eq(projectWebhooks.id, webhookId),
          eq(projectWebhooks.orgId, orgId),
          eq(projectWebhooks.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row[0]) throw new NotFoundException("Webhook not found");
  }

  async listDeliveries(orgId: string, projectId: number, webhookId: number) {
    await this.assertWebhookOwnership(orgId, projectId, webhookId);
    return this.db
      .select({
        id: webhookDeliveries.id,
        webhookId: webhookDeliveries.webhookId,
        event: webhookDeliveries.event,
        status: webhookDeliveries.status,
        responseCode: webhookDeliveries.responseCode,
        attempts: webhookDeliveries.attempts,
        lastError: webhookDeliveries.lastError,
        deliveredAt: webhookDeliveries.deliveredAt,
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.deliveredAt))
      .limit(20);
  }
}
