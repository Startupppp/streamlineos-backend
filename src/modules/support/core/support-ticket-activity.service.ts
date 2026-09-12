import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, lt, sql } from "drizzle-orm";
import {
  supportTicketActivity,
  supportTickets,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import type { ScopedRead } from "../../access/scoped-read";
import { assertTicketInScope, supportTicketScope } from "./support-tickets-scope";
import type {
  TicketPriority,
  TicketStatus,
  UpdateTicketInput,
} from "./dto/support.schemas";

export type TicketActivityAction =
  | "created"
  | "status_changed"
  | "priority_changed"
  | "assignee_changed"
  | "replied"
  | "internal_note"
  | "resolved"
  | "reopened"
  | "merged"
  | "linked"
  | "split"
  | "snoozed"
  | "unsnoozed";

const ACTION_LABELS: Record<string, string> = {
  created: "created the ticket",
  status_changed: "changed status",
  priority_changed: "changed priority",
  assignee_changed: "changed assignee",
  replied: "replied",
  internal_note: "added an internal note",
  resolved: "resolved the ticket",
  reopened: "reopened the ticket",
  merged: "merged the ticket",
  split: "split the ticket",
  linked: "linked a related ticket",
  snoozed: "snoozed the ticket",
  unsnoozed: "unsnoozed the ticket",
};

@Injectable()
export class SupportTicketActivityService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async recordActivity(
    orgId: string,
    ticketId: number,
    userId: string | null,
    action: TicketActivityAction,
    fromValue: string | null,
    toValue: string | null,
  ) {
    try {
      await this.db.insert(supportTicketActivity).values({
        orgId,
        supportTicketId: ticketId,
        userId,
        action,
        fromValue,
        toValue,
      });
    } catch (activityError) {
      logger.error("Failed to log support ticket activity", {
        orgId,
        ticketId,
        userId,
        action,
        fromValue,
        toValue,
        error: activityError instanceof Error ? activityError.message : String(activityError),
      });
    }
  }

  async logTicketActivity(
    orgId: string,
    ticketId: number,
    userId: string,
    previous: { status: TicketStatus; priority: TicketPriority | null; assigneeId: string | null },
    input: UpdateTicketInput,
  ) {
    const entries: { action: TicketActivityAction; fromValue: string | null; toValue: string | null }[] = [];

    if (input.status && input.status !== previous.status) {
      const action: TicketActivityAction =
        input.status === "RESOLVED"
          ? "resolved"
          : (previous.status === "RESOLVED" || previous.status === "CLOSED") &&
              input.status !== "CLOSED"
            ? "reopened"
            : "status_changed";
      entries.push({ action, fromValue: previous.status, toValue: input.status });
    }

    if (input.priority && input.priority !== previous.priority) {
      entries.push({
        action: "priority_changed",
        fromValue: previous.priority,
        toValue: input.priority,
      });
    }

    if (input.assigneeId !== undefined && input.assigneeId !== (previous.assigneeId ?? "")) {
      entries.push({
        action: "assignee_changed",
        fromValue: previous.assigneeId,
        toValue: input.assigneeId || null,
      });
    }

    for (const entry of entries) {
      await this.recordActivity(orgId, ticketId, userId, entry.action, entry.fromValue, entry.toValue);
    }
  }

  async listActivity(orgId: string, ticketId: number, read: ScopedRead) {
    await assertTicketInScope(this.db, read, ticketId);

    const rows = await this.db
      .select({
        id: supportTicketActivity.id,
        action: supportTicketActivity.action,
        fromValue: supportTicketActivity.fromValue,
        toValue: supportTicketActivity.toValue,
        createdAt: supportTicketActivity.createdAt,
        userId: supportTicketActivity.userId,
        userName: users.name,
        userImage: users.image,
      })
      .from(supportTicketActivity)
      .leftJoin(users, eq(supportTicketActivity.userId, users.id))
      .where(
        and(
          eq(supportTicketActivity.supportTicketId, ticketId),
          eq(supportTicketActivity.orgId, orgId),
        ),
      )
      .orderBy(desc(supportTicketActivity.createdAt));

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      label: ACTION_LABELS[row.action] ?? row.action,
      fromValue: row.fromValue,
      toValue: row.toValue,
      createdAt: row.createdAt,
      userId: row.userId,
      userName: row.userName,
      userImage: row.userImage,
    }));
  }

  async stats(read: ScopedRead) {
    const now = new Date();
    const scope = supportTicketScope(read.orgId, read.actorId);
    const [statusAggs, slaBreached] = await Promise.all([
      read.read(
        { tenant: supportTickets.orgId, scope },
        ({ sql: where }) => this.db
          .select({ status: supportTickets.status, cnt: count() })
          .from(supportTickets)
          .where(where)
          .groupBy(supportTickets.status),
        () => [],
      ),
      read.read(
        {
          tenant: supportTickets.orgId,
          scope,
          and: [
            sql`${supportTickets.slaDeadline} IS NOT NULL`,
            lt(supportTickets.slaDeadline, now),
            sql`${supportTickets.status} NOT IN ('RESOLVED', 'CLOSED')`,
          ],
        },
        ({ sql: where }) => this.db
          .select({ cnt: count() })
          .from(supportTickets)
          .where(where),
        () => [],
      ),
    ]);

    const statusMap = new Map(statusAggs.map((r) => [r.status, Number(r.cnt)]));

    return {
      open: statusMap.get("OPEN") ?? 0,
      in_progress: statusMap.get("IN_PROGRESS") ?? 0,
      waiting: statusMap.get("WAITING") ?? 0,
      resolved: statusMap.get("RESOLVED") ?? 0,
      closed: statusMap.get("CLOSED") ?? 0,
      sla_breached: Number(slaBreached[0]?.cnt ?? 0),
    };
  }
}
