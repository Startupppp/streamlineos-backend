import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomBytes } from "crypto";

import {
  WEBHOOK_RESPONSE_BODY_LIMIT,
  type ListInput,
  type LogsInput,
  type UpdateInput,
  type CreateInput,
} from "./dto/webhook.schemas";
import { type Db } from "../../db/drizzle.module";
import { webhookEndpoints, webhookLogs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";

@Injectable()
export class WebhooksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, filters: ListInput) {
    const where = eq(webhookEndpoints.orgId, orgId);
    const [endpoints, [{ total }]] = await Promise.all([
      this.db.query.webhookEndpoints.findMany({
        where,
        orderBy: [desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id)],
        limit: filters.limit,
        offset: (filters.page - 1) * filters.limit,
      }),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(webhookEndpoints)
        .where(where),
    ]);

    return {
      data: endpoints.map(({ secret: _, ...rest }) => rest),
      pagination: {
        total,
        page: filters.page,
        limit: filters.limit,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  }

  async create(orgId: string, userId: string, input: CreateInput) {
    const secret = randomBytes(32).toString("hex");
    const [endpoint] = await this.db
      .insert(webhookEndpoints)
      .values({
        orgId,
        url: input.url,
        secret,
        description: input.description,
        events: input.events,
        createdBy: userId,
      })
      .returning();

    return endpoint;
  }

  async getEndpoint(orgId: string, id: number) {
    const endpoint = await this.db.query.webhookEndpoints.findFirst({
      where: and(
        eq(webhookEndpoints.id, id),
        eq(webhookEndpoints.orgId, orgId),
      ),
    });
    if (!endpoint) return null;

    const { secret: _, ...safe } = endpoint;
    return safe;
  }

  async update(orgId: string, id: number, input: UpdateInput) {
    const [updated] = await this.db
      .update(webhookEndpoints)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.orgId, orgId)),
      )
      .returning();

    if (!updated) return null;

    const { secret: _, ...safe } = updated;
    return safe;
  }

  async remove(orgId: string, id: number) {
    const [deleted] = await this.db
      .delete(webhookEndpoints)
      .where(
        and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.orgId, orgId)),
      )
      .returning({ id: webhookEndpoints.id });

    if (!deleted) return null;
    return { success: true };
  }

  async listLogs(orgId: string, endpointId: number, filters: LogsInput) {
    const endpoint = await this.getEndpoint(orgId, endpointId);
    if (!endpoint) return null;

    const where = and(
      eq(webhookLogs.endpointId, endpointId),
      eq(webhookLogs.orgId, orgId),
    );
    const [logs, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(webhookLogs)
        .where(where)
        .orderBy(desc(webhookLogs.createdAt))
        .limit(filters.limit)
        .offset((filters.page - 1) * filters.limit),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(webhookLogs)
        .where(where),
    ]);

    return {
      data: logs.map((log) => ({
        ...log,
        responseBody: log.responseBody?.slice(0, WEBHOOK_RESPONSE_BODY_LIMIT) ?? null,
      })),
      pagination: {
        total,
        page: filters.page,
        limit: filters.limit,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  }
}
