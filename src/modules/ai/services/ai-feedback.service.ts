import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { aiFeedback } from "../../../db/schema/ai-feedback";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateFeedbackDto } from "../dto/ai-feedback.schemas";

const MAX_REASON_LENGTH = 1000;

@Injectable()
export class AiFeedbackService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async insertFeedback(orgId: string, userId: string, dto: CreateFeedbackDto): Promise<void> {
    if (dto.reason && dto.reason.length > MAX_REASON_LENGTH) {
      throw new BadRequestException(`reason must be at most ${MAX_REASON_LENGTH} characters`);
    }
    await this.db.insert(aiFeedback).values({
      orgId,
      userId,
      feature: dto.feature,
      correlationId: dto.correlationId ?? null,
      entityType: dto.entityType ?? null,
      entityId: dto.entityId ?? null,
      rating: dto.rating,
      reason: dto.reason ?? null,
      metadata: dto.metadata ?? null,
    });
  }

  async getSummary(orgId: string, feature?: string, days?: number) {
    const conditions = [eq(aiFeedback.orgId, orgId)];
    if (feature) conditions.push(eq(aiFeedback.feature, feature));
    if (days && days > 0) {
      const since = new Date(Date.now() - days * 86_400_000);
      conditions.push(gte(aiFeedback.createdAt, since));
    }

    const rows = await this.db
      .select({
        feature: aiFeedback.feature,
        up: sql<number>`COUNT(*) FILTER (WHERE ${aiFeedback.rating} = 'UP')::int`,
        down: sql<number>`COUNT(*) FILTER (WHERE ${aiFeedback.rating} = 'DOWN')::int`,
        total: count(),
      })
      .from(aiFeedback)
      .where(and(...conditions))
      .groupBy(aiFeedback.feature);

    return rows.map((r) => ({
      feature: r.feature,
      up: r.up,
      down: r.down,
      total: r.total,
      ratio: r.total > 0 ? Number((r.up / r.total).toFixed(4)) : null,
    }));
  }
}
