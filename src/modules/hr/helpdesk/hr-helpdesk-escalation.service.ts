import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, lt, ne, sql } from "drizzle-orm";
import { helpdeskTickets, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { forEachOrg } from "../../../common/tenant";
import { AccessService } from "../../access/access.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { HrAuditService } from "../core/hr-audit.service";
import { HrHelpdeskConfigService } from "./hr-helpdesk-config.service";
import {
  SUPPORT_ADMIN_PERMISSION,
  SUPPORT_QUEUE_LABELS,
  selectEscalationTarget,
  slaBreach,
  type SupportQueue,
} from "./lib/support-queues";

export const ESCALATION_BATCH = 200;

export interface EscalationSweepResult {
  organizations: number;
  organizationsFailed: number;
  escalated: number;
  unassignable: number;
}

export interface OrgEscalationOutcome {
  escalated: number;
  unassignable: number;
}

export interface EscalationAdminsReader {
  membersWithPermission(
    orgId: string,
    permissionKey: string,
  ): Promise<ReadonlyArray<{ userId: string; membershipId: number }>>;
}

@Injectable()
export class HrHelpdeskEscalationService {
  private readonly logger = new Logger(HrHelpdeskEscalationService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly config: HrHelpdeskConfigService,
    private readonly access: AccessService,
    private readonly dispatch: NotificationDispatchService,
    private readonly audit: HrAuditService,
  ) {}

  async sweep(now: Date = new Date()): Promise<EscalationSweepResult> {
    const result: EscalationSweepResult = { organizations: 0, organizationsFailed: 0, escalated: 0, unassignable: 0 };
    const outcome = await forEachOrg(this.db, "helpdesk-escalation", async (tx, orgId) => {
      const orgOutcome = await this.sweepOrg(tx, orgId, now, this.access);
      result.escalated += orgOutcome.escalated;
      result.unassignable += orgOutcome.unassignable;
    });
    result.organizations = outcome.organizations;
    result.organizationsFailed = outcome.failed;
    this.logger.log(
      `[helpdesk-escalation] ${result.escalated} escalated (${result.unassignable} without a target) across ${result.organizations} orgs (${result.organizationsFailed} failed)`,
    );
    return result;
  }

  async sweepOrg(
    tx: DbOrTx,
    orgId: string,
    now: Date,
    admins: EscalationAdminsReader,
  ): Promise<OrgEscalationOutcome> {
    const overdue = await tx
      .select({
        id: helpdeskTickets.id,
        title: helpdeskTickets.title,
        queue: helpdeskTickets.queue,
        userId: helpdeskTickets.userId,
        assigneeId: helpdeskTickets.assigneeId,
        firstResponseDueAt: helpdeskTickets.firstResponseDueAt,
        firstRespondedAt: helpdeskTickets.firstRespondedAt,
        slaDueAt: helpdeskTickets.slaDueAt,
      })
      .from(helpdeskTickets)
      .where(
        and(
          eq(helpdeskTickets.orgId, orgId),
          eq(helpdeskTickets.escalationLevel, 0),
          ne(helpdeskTickets.status, "DONE"),
          sql`(${lt(helpdeskTickets.slaDueAt, now)} OR (${helpdeskTickets.firstRespondedAt} IS NULL AND ${lt(helpdeskTickets.firstResponseDueAt, now)}))`,
        ),
      )
      .orderBy(asc(helpdeskTickets.slaDueAt), asc(helpdeskTickets.id))
      .limit(ESCALATION_BATCH);

    if (overdue.length === 0) return { escalated: 0, unassignable: 0 };

    const [configs, adminMembers] = await Promise.all([
      this.config.queueConfigs(orgId, tx),
      admins.membersWithPermission(orgId, SUPPORT_ADMIN_PERMISSION),
    ]);

    const outcome: OrgEscalationOutcome = { escalated: 0, unassignable: 0 };
    for (const ticket of overdue) {
      const breach = slaBreach(ticket, now);
      if (breach === null) continue;
      const queue: SupportQueue = ticket.queue;
      const targetUserId = selectEscalationTarget(configs[queue].escalationUserId, adminMembers, ticket.assigneeId);
      const targetMembershipId = targetUserId ? await this.membershipIdOf(tx, orgId, targetUserId) : null;
      const reassign = targetUserId !== null && targetMembershipId !== null;

      const [updated] = await tx
        .update(helpdeskTickets)
        .set({
          escalationLevel: 1,
          escalatedAt: now,
          updatedAt: now,
          ...(reassign ? { assigneeId: targetUserId, assigneeMembershipId: targetMembershipId } : {}),
        })
        .where(
          and(
            eq(helpdeskTickets.id, ticket.id),
            eq(helpdeskTickets.orgId, orgId),
            eq(helpdeskTickets.escalationLevel, 0),
          ),
        )
        .returning({ id: helpdeskTickets.id });
      if (!updated) continue;

      outcome.escalated += 1;
      if (!reassign) outcome.unassignable += 1;

      await this.audit.log(
        {
          orgId,
          actorId: null,
          actorMembershipId: null,
          entityType: "helpdesk_ticket",
          entityId: String(ticket.id),
          action: "helpdesk.ticket.escalated",
          before: { assigneeId: ticket.assigneeId, escalationLevel: 0 },
          after: { breach, queue, assigneeId: reassign ? targetUserId : ticket.assigneeId, escalationLevel: 1 },
        },
        tx,
      );

      const recipients = new Set<string>();
      if (reassign && targetUserId) recipients.add(targetUserId);
      else for (const admin of adminMembers) recipients.add(admin.userId);
      if (recipients.size === 0) continue;

      await this.dispatch.emit({
        orgId,
        dedupeKey: `helpdesk:escalated:${ticket.id}:1`,
        eventKey: "hr.helpdesk.ticket_escalated",
        targetUserIds: [...recipients],
        entityType: "helpdesk_ticket",
        entityId: String(ticket.id),
        title: ticket.title,
        message: `${SUPPORT_QUEUE_LABELS[queue]} request "${ticket.title}" breached its ${breach === "first_response" ? "first-response" : "resolution"} SLA and was escalated.`,
        link: `/hr/helpdesk?queue=${queue}&ticket=${ticket.id}`,
        variables: { ticketId: String(ticket.id), title: ticket.title, queue, breach },
      });
    }
    return outcome;
  }

  private async membershipIdOf(tx: DbOrTx, orgId: string, userId: string): Promise<number | null> {
    const [row] = await tx
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }
}
