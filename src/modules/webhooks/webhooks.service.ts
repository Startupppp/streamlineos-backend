import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { randomBytes } from "crypto";

import {
  encryptSecret,
  maskSecretHint,
} from "../../common/security/secret-encryption.util";

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
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBeforeId } from "../../common/pagination/keyset";

@Injectable()
export class WebhooksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, filters: ListInput) {
    const position = decodeCursor(filters.cursor);
    if (filters.cursor !== undefined && !position) {
      throw new BadRequestException("Invalid pagination cursor");
    }

    const conditions = [eq(webhookEndpoints.orgId, orgId)];
    if (position) {
      conditions.push(
        keysetBeforeId(webhookEndpoints.createdAt, webhookEndpoints.id, position),
      );
    }
    const endpoints = await this.db.query.webhookEndpoints.findMany({
      where: and(...conditions),
      orderBy: [desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id)],
      limit: filters.limit + 1,
    });
    const page = buildCursorPage(endpoints, filters.limit, (endpoint) => ({
      sortValue: endpoint.createdAt.toISOString(),
      id: String(endpoint.id),
    }));

    return {
      data: page.data.map(({ secret: _, ...rest }) => rest),
      pagination: page.pagination,
    };
  }

  async create(orgId: string, userId: string, input: CreateInput) {
    const secret = randomBytes(32).toString("hex");
    const [endpoint] = await this.db
      .insert(webhookEndpoints)
      .values({
        orgId,
        url: input.url,
        secret: encryptSecret(secret),
        description: input.description,
        events: input.events,
        createdBy: userId,
      })
      .returning();
    if (!endpoint) throw new NotFoundException("Webhook endpoint could not be created");

    return { ...endpoint, secret, secretHint: maskSecretHint(secret) };
  }

  /**
   * Reveal-once rotation. The plaintext is returned exactly here and never
   * again — every other read strips `secret`, and the column holds ciphertext.
   */
  async rotateSecret(orgId: string, id: number) {
    const secret = randomBytes(32).toString("hex");
    const [updated] = await this.db
      .update(webhookEndpoints)
      .set({ secret: encryptSecret(secret) })
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Webhook endpoint not found");

    return { id: updated.id, secret, secretHint: maskSecretHint(secret) };
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

    const position = decodeCursor(filters.cursor);
    if (filters.cursor !== undefined && !position) {
      throw new BadRequestException("Invalid pagination cursor");
    }

    const conditions = [
      eq(webhookLogs.endpointId, endpointId),
      eq(webhookLogs.orgId, orgId),
    ];
    if (position) {
      conditions.push(
        keysetBeforeId(webhookLogs.createdAt, webhookLogs.id, position),
      );
    }
    const logs = await this.db
      .select()
      .from(webhookLogs)
      .where(and(...conditions))
      .orderBy(desc(webhookLogs.createdAt), desc(webhookLogs.id))
      .limit(filters.limit + 1);
    const page = buildCursorPage(logs, filters.limit, (log) => ({
      sortValue: log.createdAt.toISOString(),
      id: String(log.id),
    }));

    return {
      data: page.data.map((log) => ({
        ...log,
        responseBody: log.responseBody?.slice(0, WEBHOOK_RESPONSE_BODY_LIMIT) ?? null,
      })),
      pagination: page.pagination,
    };
  }
}
