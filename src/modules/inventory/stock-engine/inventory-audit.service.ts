import { Inject, Injectable } from "@nestjs/common";
import { invAuditEvents } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

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
    const before = input.before != null && typeof input.before === "object" ? (input.before as Record<string, unknown>) : null;
    const after = input.after != null && typeof input.after === "object" ? (input.after as Record<string, unknown>) : null;
    const metadata = input.metadata != null && typeof input.metadata === "object" ? (input.metadata as Record<string, unknown>) : null;
    await tx.insert(invAuditEvents).values({
      orgId: input.orgId,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      before,
      after,
      metadata,
    });
  }
}
