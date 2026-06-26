import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { webhookEndpoints } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateInput, ListInput, UpdateInput } from "./dto/webhook.schemas";

@Injectable()
export class WebhooksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, filters: ListInput) {
    const endpoints = await this.db.query.webhookEndpoints.findMany({
      where: eq(webhookEndpoints.orgId, orgId),
      orderBy: [desc(webhookEndpoints.createdAt)],
      limit: filters.pageSize,
      offset: (filters.page - 1) * filters.pageSize,
    });

    return endpoints.map(({ secret: _secret, ...rest }) => rest);
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
      where: and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.orgId, orgId)),
    });
    if (!endpoint) return null;

    const { secret: _secret, ...safe } = endpoint;
    return safe;
  }

  async update(orgId: string, id: number, input: UpdateInput) {
    const [updated] = await this.db
      .update(webhookEndpoints)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.orgId, orgId)))
      .returning();

    if (!updated) return null;

    const { secret: _secret, ...safe } = updated;
    return safe;
  }

  async remove(orgId: string, id: number) {
    const [deleted] = await this.db
      .delete(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.orgId, orgId)))
      .returning({ id: webhookEndpoints.id });

    if (!deleted) return null;
    return { success: true };
  }
}
