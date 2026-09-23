import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { supportTickets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  descKeyset,
  type DescKeysetPosition,
} from "../../common/pagination/desc-keyset";
import { AttentionAdapterRegistry } from "../attention/attention-adapter.registry";
import type {
  InboxSourcePosition,
  ModuleTaskInboxItem,
} from "../notifications/dto/unified-inbox.schemas";

const OPEN_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING"] as const;

@Injectable()
export class SupportAttentionAdapter implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: AttentionAdapterRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      module: "support",
      kindLabel: "support_ticket",
      permission: "support:tickets:view",
      supportsAfterCursor: true,
      fetch: (_orgId, _userId, membershipId, limit, cursor) =>
        this.fetchTickets(_orgId, membershipId, limit, cursor),
      countPending: (_orgId, _userId, membershipId) =>
        this.countTickets(_orgId, membershipId),
    });
  }

  private async fetchTickets(
    orgId: string,
    membershipId: number | null,
    limit: number,
    cursor: InboxSourcePosition | null,
  ): Promise<ModuleTaskInboxItem[]> {
    if (membershipId === null) return [];
    const rows = await this.db
      .select({
        id: supportTickets.id,
        title: supportTickets.title,
        status: supportTickets.status,
        priority: supportTickets.priority,
        slaDeadline: supportTickets.slaDeadline,
        createdAt: supportTickets.createdAt,
      })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.orgId, orgId),
          eq(supportTickets.assigneeMembershipId, membershipId),
          inArray(supportTickets.status, [...OPEN_STATUSES]),
          isNull(supportTickets.mergedIntoTicketId),
          descKeyset(
            supportTickets.createdAt,
            supportTickets.id,
            cursor as DescKeysetPosition | null,
          ),
        ),
      )
      .orderBy(desc(supportTickets.createdAt), desc(supportTickets.id))
      .limit(limit);

    return rows.map(
      (row): ModuleTaskInboxItem => ({
        kind: "module_task",
        id: String(row.id),
        taskKind: "support_ticket",
        status: row.status,
        priority: row.priority,
        dueAt: row.slaDeadline ? row.slaDeadline.toISOString() : null,
        body: row.title,
        sourceModule: "support",
        actor: null,
        subject: row.title,
        timestamp: row.createdAt.toISOString(),
        isRead: false,
        deepLink: "/support/inbox",
        dedupKey: `task:support:${String(row.id)}`,
      }),
    );
  }

  private async countTickets(
    orgId: string,
    membershipId: number | null,
  ): Promise<number> {
    if (membershipId === null) return 0;
    const [result] = await this.db
      .select({ n: count() })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.orgId, orgId),
          eq(supportTickets.assigneeMembershipId, membershipId),
          inArray(supportTickets.status, [...OPEN_STATUSES]),
          isNull(supportTickets.mergedIntoTicketId),
        ),
      );
    return result?.n ?? 0;
  }
}
