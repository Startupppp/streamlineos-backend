import { Inject, Injectable } from "@nestjs/common";
import { invAuditEvents } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

interface AuditInsertInput {
  orgId: string;
  actorUserId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

@Injectable()
export class InventoryAuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async insert(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0] | Db,
    input: AuditInsertInput,
  ): Promise<void> {
    await (tx as Db).insert(invAuditEvents).values({
      orgId: input.orgId,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      before: input.before as Record<string, unknown> ?? null,
      after: input.after as Record<string, unknown> ?? null,
      metadata: input.metadata as Record<string, unknown> ?? null,
    });
  }
}
