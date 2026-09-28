import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, eq, desc, ilike, inArray, lt, gte, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import {
  projectWebhooks,
  webhookDeliveries,
} from "../../../../db/schema/build/tasks";
import type {
  CreateWebhookInput,
  ListWebhooksQuery,
  UpdateWebhookInput,
} from "../dto/webhook.schemas";
import { generateWebhookSecret } from "./projects-webhooks-dispatch.service";
import { assertProjectInOrg } from "../project-crud/project-access";
import { buildIdCursorPage } from "../../../../common/pagination/cursor";
import { TicketVersionConflictException } from "../tickets/ticket-version-conflict.exception";

const PAGE_SIZE = 50;

const webhookProjection = {
  id: projectWebhooks.id,
  orgId: projectWebhooks.orgId,
  projectId: projectWebhooks.projectId,
  url: projectWebhooks.url,
  events: projectWebhooks.events,
  isActive: projectWebhooks.isActive,
  hasSecret: sql<boolean>`${projectWebhooks.secret} IS NOT NULL`,
  secretSetAt: projectWebhooks.secretSetAt,
  version: projectWebhooks.version,
  createdAt: projectWebhooks.createdAt,
  updatedAt: projectWebhooks.updatedAt,
};

@Injectable()
export class ProjectsWebhooksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listWebhooks(
    orgId: string,
    projectId: number,
    filters: ListWebhooksQuery = {},
  ) {
    await assertProjectInOrg(this.db, orgId, projectId);

    const conditions = [
      eq(projectWebhooks.orgId, orgId),
      eq(projectWebhooks.projectId, projectId),
    ];

    if (filters.state === "active")
      conditions.push(eq(projectWebhooks.isActive, true));
    if (filters.state === "inactive")
      conditions.push(eq(projectWebhooks.isActive, false));
    if (filters.event)
      conditions.push(
        sql`${projectWebhooks.events} @> ARRAY[${filters.event}]::text[]`,
      );
    if (filters.q) conditions.push(ilike(projectWebhooks.url, `${filters.q}%`));
    if (filters.cursor !== undefined)
      conditions.push(lt(projectWebhooks.id, filters.cursor));
    if (filters.from)
      conditions.push(gte(projectWebhooks.createdAt, filters.from));
    if (filters.to) conditions.push(lte(projectWebhooks.createdAt, filters.to));

    const rows = await this.db
      .select({
        id: projectWebhooks.id,
        orgId: projectWebhooks.orgId,
        projectId: projectWebhooks.projectId,
        url: projectWebhooks.url,
        events: projectWebhooks.events,
        isActive: projectWebhooks.isActive,
        hasSecret: sql<boolean>`${projectWebhooks.secret} IS NOT NULL`,
        secretSetAt: projectWebhooks.secretSetAt,
        version: projectWebhooks.version,
        createdAt: projectWebhooks.createdAt,
        updatedAt: projectWebhooks.updatedAt,
      })
      .from(projectWebhooks)
      .where(and(...conditions))
      .orderBy(desc(projectWebhooks.id))
      .limit(PAGE_SIZE + 1);

    const page = buildIdCursorPage(rows, PAGE_SIZE, (row) => row.id);

    if (page.data.length === 0) {
      return {
        ...page,
        data: page.data.map((row) => ({
          ...row,
          lastDeliveryAt: null,
          lastDeliveryStatus: null,
          failureRate: null,
        })),
      };
    }

    const webhookIds = page.data.map((r) => r.id);

    const statsRows = await this.db.execute<{
      webhookId: number;
      lastDeliveryAt: Date | null;
      lastDeliveryStatus: string | null;
      failureRate: number | null;
    }>(sql`
      WITH ranked AS (
        SELECT
          webhook_id,
          delivered_at,
          status,
          ROW_NUMBER() OVER (PARTITION BY webhook_id ORDER BY delivered_at DESC) AS rn,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) OVER (PARTITION BY webhook_id)::float
            / NULLIF(COUNT(*) OVER (PARTITION BY webhook_id), 0) AS failure_rate
        FROM build.webhook_deliveries
        WHERE org_id = ${orgId}
          AND webhook_id = ANY(${webhookIds})
      )
      SELECT
        webhook_id::int AS "webhookId",
        delivered_at AS "lastDeliveryAt",
        status AS "lastDeliveryStatus",
        failure_rate AS "failureRate"
      FROM ranked
      WHERE rn = 1
    `);

    const statsMap = new Map<
      number,
      {
        lastDeliveryAt: Date | null;
        lastDeliveryStatus: string | null;
        failureRate: number | null;
      }
    >();
    for (const row of statsRows) {
      statsMap.set(row.webhookId, {
        lastDeliveryAt: row.lastDeliveryAt,
        lastDeliveryStatus: row.lastDeliveryStatus,
        failureRate: row.failureRate,
      });
    }

    return {
      ...page,
      data: page.data.map((row) => {
        const stats = statsMap.get(row.id);
        return {
          ...row,
          lastDeliveryAt: stats?.lastDeliveryAt ?? null,
          lastDeliveryStatus: stats?.lastDeliveryStatus ?? null,
          failureRate: stats?.failureRate ?? null,
        };
      }),
    };
  }

  async createWebhook(
    orgId: string,
    projectId: number,
    createdBy: string,
    data: CreateWebhookInput,
  ) {
    await assertProjectInOrg(this.db, orgId, projectId);
    const secret = data.secret ?? generateWebhookSecret();
    const [webhook] = await this.db
      .insert(projectWebhooks)
      .values({
        orgId,
        projectId,
        createdBy,
        url: data.url,
        events: data.events,
        secret,
        secretSetAt: new Date(),
      })
      .returning(webhookProjection);
    return {
      ...webhook,
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      failureRate: null,
    };
  }

  async updateWebhook(
    orgId: string,
    projectId: number,
    webhookId: number,
    data: UpdateWebhookInput,
  ) {
    const tenantMatch = and(
      eq(projectWebhooks.id, webhookId),
      eq(projectWebhooks.orgId, orgId),
      eq(projectWebhooks.projectId, projectId),
    );
    const [before] = await this.db
      .select({ version: projectWebhooks.version })
      .from(projectWebhooks)
      .where(tenantMatch)
      .limit(1);
    if (!before) throw new NotFoundException("Webhook not found");
    if (data.version !== before.version)
      throw new TicketVersionConflictException(before.version);

    const changes = {
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.events !== undefined ? { events: data.events } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    };

    const [updated] = await this.db
      .update(projectWebhooks)
      .set({ ...changes, updatedAt: new Date() })
      .where(and(tenantMatch, eq(projectWebhooks.version, before.version)))
      .returning(webhookProjection);
    if (!updated) {
      const [current] = await this.db
        .select({ version: projectWebhooks.version })
        .from(projectWebhooks)
        .where(tenantMatch)
        .limit(1);
      throw new TicketVersionConflictException(
        current?.version ?? before.version,
      );
    }
    return {
      ...updated,
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      failureRate: null,
    };
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

  async assertWebhookOwnership(
    orgId: string,
    projectId: number,
    webhookId: number,
  ): Promise<void> {
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
      .where(
        and(
          eq(webhookDeliveries.orgId, orgId),
          eq(webhookDeliveries.webhookId, webhookId),
        ),
      )
      .orderBy(desc(webhookDeliveries.deliveredAt))
      .limit(20);
  }
}
