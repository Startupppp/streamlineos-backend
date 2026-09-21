import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, lt, ne, sql } from "drizzle-orm";
import { helpdeskQueues, helpdeskTickets, hrHelpdeskRouting, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import { HrAuditService } from "../core/hr-audit.service";
import type { QueueConfigInput, RoutingRuleInput } from "./dto/hr-helpdesk.schemas";
import {
  DEFAULT_CATEGORY_QUEUE,
  DEFAULT_QUEUE_SLA,
  HELPDESK_CATEGORIES,
  SUPPORT_QUEUES,
  SUPPORT_QUEUE_LABELS,
  type HelpdeskCategory,
  type QueueSla,
  type SupportActor,
  type SupportQueue,
} from "./lib/support-queues";

export interface EffectiveQueueConfig extends QueueSla {
  queue: SupportQueue;
  source: "default" | "org";
  escalationUserId: string | null;
  escalationMembershipId: number | null;
}

@Injectable()
export class HrHelpdeskConfigService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async routingRuleFor(orgId: string, category: HelpdeskCategory) {
    const [rule] = await this.db
      .select({
        queue: hrHelpdeskRouting.queue,
        assigneeUserId: hrHelpdeskRouting.assigneeUserId,
      })
      .from(hrHelpdeskRouting)
      .where(and(eq(hrHelpdeskRouting.orgId, orgId), eq(hrHelpdeskRouting.category, category)))
      .limit(1);
    return rule ?? null;
  }

  async listRoutingRules(orgId: string) {
    const rows = await this.db
      .select({
        id: hrHelpdeskRouting.id,
        category: hrHelpdeskRouting.category,
        queue: hrHelpdeskRouting.queue,
        assigneeUserId: hrHelpdeskRouting.assigneeUserId,
        assigneeName: users.name,
        assigneeImage: users.image,
      })
      .from(hrHelpdeskRouting)
      .leftJoin(users, eq(users.id, hrHelpdeskRouting.assigneeUserId))
      .where(eq(hrHelpdeskRouting.orgId, orgId))
      .limit(HELPDESK_CATEGORIES.length);
    const byCategory = new Map(rows.map((row) => [row.category, row]));
    return HELPDESK_CATEGORIES.map((category) => {
      const rule = byCategory.get(category);
      return {
        category,
        queue: rule?.queue ?? DEFAULT_CATEGORY_QUEUE[category],
        source: rule ? ("org" as const) : ("default" as const),
        ruleId: rule?.id ?? null,
        assigneeUserId: rule?.assigneeUserId ?? null,
        assigneeName: rule?.assigneeName ?? null,
        assigneeImage: rule?.assigneeImage ?? null,
      };
    });
  }

  private async resolveMembershipId(orgId: string, userId: string): Promise<number> {
    try {
      const actor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId });
      return actor.membershipId;
    } catch (e) {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    }
  }

  async upsertRoutingRule(actor: SupportActor, body: RoutingRuleInput) {
    const assigneeUserId = body.assigneeUserId ?? null;
    const assigneeMembershipId = assigneeUserId
      ? await this.resolveMembershipId(actor.orgId, assigneeUserId)
      : null;
    const queue = body.queue ?? null;

    await this.db.transaction(async (tx) => {
      await tx
        .insert(hrHelpdeskRouting)
        .values({ orgId: actor.orgId, category: body.category, queue, assigneeUserId, assigneeMembershipId })
        .onConflictDoUpdate({
          target: [hrHelpdeskRouting.orgId, hrHelpdeskRouting.category],
          set: { queue, assigneeUserId, assigneeMembershipId, updatedAt: new Date() },
        });
      await this.audit.log(
        {
          orgId: actor.orgId,
          actorId: actor.userId,
          actorMembershipId: actor.membershipId,
          entityType: "helpdesk_routing",
          entityId: body.category,
          action: "helpdesk.routing.upserted",
          after: { queue, assigneeUserId },
        },
        tx,
      );
    });

    const rules = await this.listRoutingRules(actor.orgId);
    const rule = rules.find((candidate) => candidate.category === body.category);
    if (!rule) throw new NotFoundException("Routing rule not found after upsert.");
    return rule;
  }

  async deleteRoutingRule(actor: SupportActor, ruleId: number) {
    await this.db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(hrHelpdeskRouting)
        .where(and(eq(hrHelpdeskRouting.id, ruleId), eq(hrHelpdeskRouting.orgId, actor.orgId)))
        .returning({ id: hrHelpdeskRouting.id, category: hrHelpdeskRouting.category });
      if (!deleted) throw new NotFoundException("Routing rule not found.");
      await this.audit.log(
        {
          orgId: actor.orgId,
          actorId: actor.userId,
          actorMembershipId: actor.membershipId,
          entityType: "helpdesk_routing",
          entityId: deleted.category,
          action: "helpdesk.routing.deleted",
        },
        tx,
      );
    });
    return { success: true };
  }

  async queueConfigs(orgId: string, db: DbOrTx = this.db): Promise<Record<SupportQueue, EffectiveQueueConfig>> {
    const rows = await db
      .select({
        queue: helpdeskQueues.queue,
        firstResponseHours: helpdeskQueues.firstResponseHours,
        resolutionHours: helpdeskQueues.resolutionHours,
        escalationUserId: helpdeskQueues.escalationUserId,
        escalationMembershipId: helpdeskQueues.escalationMembershipId,
      })
      .from(helpdeskQueues)
      .where(eq(helpdeskQueues.orgId, orgId))
      .limit(SUPPORT_QUEUES.length);
    const byQueue = new Map(rows.map((row) => [row.queue, row]));
    const configFor = (queue: SupportQueue): EffectiveQueueConfig => {
      const row = byQueue.get(queue);
      return row
        ? {
            queue,
            source: "org",
            firstResponseHours: row.firstResponseHours,
            resolutionHours: row.resolutionHours,
            escalationUserId: row.escalationUserId,
            escalationMembershipId: row.escalationMembershipId,
          }
        : {
            queue,
            source: "default",
            ...DEFAULT_QUEUE_SLA[queue],
            escalationUserId: null,
            escalationMembershipId: null,
          };
    };
    return {
      HR: configFor("HR"),
      IT: configFor("IT"),
      FINANCE: configFor("FINANCE"),
      ADMIN: configFor("ADMIN"),
      LEGAL: configFor("LEGAL"),
    };
  }

  async slaFor(orgId: string, queue: SupportQueue): Promise<QueueSla> {
    const configs = await this.queueConfigs(orgId);
    const config = configs[queue];
    return { firstResponseHours: config.firstResponseHours, resolutionHours: config.resolutionHours };
  }

  async upsertQueueConfig(actor: SupportActor, queue: SupportQueue, body: QueueConfigInput) {
    const escalationMembershipId = body.escalationUserId
      ? await this.resolveMembershipId(actor.orgId, body.escalationUserId)
      : null;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(helpdeskQueues)
        .values({
          orgId: actor.orgId,
          queue,
          firstResponseHours: body.firstResponseHours,
          resolutionHours: body.resolutionHours,
          escalationUserId: body.escalationUserId,
          escalationMembershipId,
        })
        .onConflictDoUpdate({
          target: [helpdeskQueues.orgId, helpdeskQueues.queue],
          set: {
            firstResponseHours: body.firstResponseHours,
            resolutionHours: body.resolutionHours,
            escalationUserId: body.escalationUserId,
            escalationMembershipId,
            updatedAt: new Date(),
          },
        });
      await this.audit.log(
        {
          orgId: actor.orgId,
          actorId: actor.userId,
          actorMembershipId: actor.membershipId,
          entityType: "helpdesk_queue",
          entityId: queue,
          action: "helpdesk.queue.configured",
          after: body,
        },
        tx,
      );
    });
    const summaries = await this.queueSummaries(actor);
    const summary = summaries.find((candidate) => candidate.queue === queue);
    if (!summary) throw new NotFoundException("Queue not found after update.");
    return summary;
  }

  async queueSummaries(actor: SupportActor) {
    const now = new Date();
    const [configs, escalationNames, openCounts, overdueCounts] = await Promise.all([
      this.queueConfigs(actor.orgId),
      this.db
        .select({ queue: helpdeskQueues.queue, escalationName: users.name })
        .from(helpdeskQueues)
        .innerJoin(users, eq(users.id, helpdeskQueues.escalationUserId))
        .where(eq(helpdeskQueues.orgId, actor.orgId))
        .limit(SUPPORT_QUEUES.length),
      this.db
        .select({ queue: helpdeskTickets.queue, total: count() })
        .from(helpdeskTickets)
        .where(and(eq(helpdeskTickets.orgId, actor.orgId), ne(helpdeskTickets.status, "DONE")))
        .groupBy(helpdeskTickets.queue),
      this.db
        .select({ queue: helpdeskTickets.queue, total: count() })
        .from(helpdeskTickets)
        .where(
          and(
            eq(helpdeskTickets.orgId, actor.orgId),
            ne(helpdeskTickets.status, "DONE"),
            sql`(${lt(helpdeskTickets.slaDueAt, now)} OR (${helpdeskTickets.firstRespondedAt} IS NULL AND ${lt(helpdeskTickets.firstResponseDueAt, now)}))`,
          ),
        )
        .groupBy(helpdeskTickets.queue),
    ]);
    const nameByQueue = new Map(escalationNames.map((row) => [row.queue, row.escalationName]));
    const openByQueue = new Map(openCounts.map((row) => [row.queue, Number(row.total)]));
    const overdueByQueue = new Map(overdueCounts.map((row) => [row.queue, Number(row.total)]));
    return SUPPORT_QUEUES.map((queue) => {
      const config = configs[queue];
      const isMember = actor.isAdmin || actor.queues.has(queue);
      return {
        queue,
        label: SUPPORT_QUEUE_LABELS[queue],
        isMember,
        source: config.source,
        firstResponseHours: config.firstResponseHours,
        resolutionHours: config.resolutionHours,
        escalationUserId: config.escalationUserId,
        escalationName: config.escalationUserId ? (nameByQueue.get(queue) ?? null) : null,
        openCount: isMember ? (openByQueue.get(queue) ?? 0) : null,
        overdueCount: isMember ? (overdueByQueue.get(queue) ?? 0) : null,
      };
    });
  }
}
