import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, eq, desc, ilike, lt, gte, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { projectWebhooks } from "../../../../db/schema/build/tasks";
import {
  integrationWebhookEndpointCredentials,
  integrationWebhookDeliveries,
} from "../../../../db/schema/integrations/webhook-delivery";
import type {
  CreateWebhookInput,
  ListWebhooksQuery,
  UpdateWebhookInput,
} from "../dto/webhook.schemas";
import { generateWebhookSecret } from "./projects-webhooks-dispatch.service";
import { assertProjectInOrg } from "../project-crud/project-access";
import { buildIdCursorPage } from "../../../../common/pagination/cursor";
import { TicketVersionConflictException } from "../tickets";

const PAGE_SIZE = 50;

const webhookProjection = {
  id: projectWebhooks.id,
  orgId: projectWebhooks.orgId,
  projectId: projectWebhooks.projectId,
  url: projectWebhooks.url,
  events: projectWebhooks.events,
  isActive: projectWebhooks.isActive,
  hasSecret: sql<boolean>`${projectWebhooks.integrationsEndpointId} IS NOT NULL`,
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
        hasSecret: sql<boolean>`${projectWebhooks.integrationsEndpointId} IS NOT NULL`,
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
          build_webhook_id,
          delivered_at,
          status,
          ROW_NUMBER() OVER (PARTITION BY build_webhook_id ORDER BY delivered_at DESC) AS rn,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) OVER (PARTITION BY build_webhook_id)::float
            / NULLIF(COUNT(*) OVER (PARTITION BY build_webhook_id), 0) AS failure_rate
        FROM integration_webhook_deliveries
        WHERE org_id = ${orgId}
          AND build_webhook_id = ANY(${webhookIds})
      )
      SELECT
        build_webhook_id::int AS "webhookId",
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
    const secretSetAt = new Date();

    return this.db.transaction(async (tx) => {
      const [credential] = await tx
        .insert(integrationWebhookEndpointCredentials)
        .values({ orgId, signingSecret: secret, secretSetAt })
        .returning({ id: integrationWebhookEndpointCredentials.id });
      if (!credential) throw new Error("Failed to create webhook credential");

      const [webhook] = await tx
        .insert(projectWebhooks)
        .values({
          orgId,
          projectId,
          createdBy,
          url: data.url,
          events: data.events,
          secret,
          secretSetAt,
          integrationsEndpointId: credential.id,
        })
        .returning(webhookProjection);
      if (!webhook) throw new Error("Failed to create webhook row");

      return {
        ...webhook,
        lastDeliveryAt: null,
        lastDeliveryStatus: null,
        failureRate: null,
      };
    });
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
      .select(webhookProjection)
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

    if (Object.keys(changes).length === 0)
      return {
        ...before,
        lastDeliveryAt: null,
        lastDeliveryStatus: null,
        failureRate: null,
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
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ integrationsEndpointId: projectWebhooks.integrationsEndpointId })
        .from(projectWebhooks)
        .where(
          and(
            eq(projectWebhooks.id, webhookId),
            eq(projectWebhooks.orgId, orgId),
            eq(projectWebhooks.projectId, projectId),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundException("Webhook not found");

      await tx
        .delete(projectWebhooks)
        .where(
          and(
            eq(projectWebhooks.id, webhookId),
            eq(projectWebhooks.projectId, projectId),
            eq(projectWebhooks.orgId, orgId),
          ),
        );

      if (row.integrationsEndpointId) {
        await tx
          .delete(integrationWebhookEndpointCredentials)
          .where(
            and(
              eq(integrationWebhookEndpointCredentials.orgId, orgId),
              eq(integrationWebhookEndpointCredentials.id, row.integrationsEndpointId),
            ),
          );
      }
    });
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
        id: integrationWebhookDeliveries.id,
        webhookId: integrationWebhookDeliveries.buildWebhookId,
        event: integrationWebhookDeliveries.event,
        status: integrationWebhookDeliveries.status,
        responseCode: integrationWebhookDeliveries.responseCode,
        attempts: integrationWebhookDeliveries.attempts,
        lastError: integrationWebhookDeliveries.lastError,
        deliveredAt: integrationWebhookDeliveries.deliveredAt,
      })
      .from(integrationWebhookDeliveries)
      .where(
        and(
          eq(integrationWebhookDeliveries.orgId, orgId),
          eq(integrationWebhookDeliveries.buildWebhookId, webhookId),
        ),
      )
      .orderBy(desc(integrationWebhookDeliveries.deliveredAt))
      .limit(20);
  }
}
