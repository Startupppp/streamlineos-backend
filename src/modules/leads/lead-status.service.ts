import { Inject, Injectable } from "@nestjs/common";
import { eq, and, count, sql, inArray } from "drizzle-orm";
import {
  leads,
  deals,
  projects,
  tickets,
  clients,
  clientAccounts,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { EmailService } from "../email/email.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { appUrl } from "../email/app-url";
import { getLeadStatusChangeEmailTemplate } from "../email/templates/crm";
import type { TransitionLeadStatusInput } from "./dto/lead-mutations.schemas";

type LeadRow = typeof leads.$inferSelect;

export type TransitionLeadStatusResult =
  | { ok: true; lead: LeadRow }
  | { ok: false; reason: "already_converted" | "stale_or_missing" };

@Injectable()
export class LeadStatusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly email: EmailService,
  ) {}

  private async getNextCrmAssignee(orgId: string): Promise<string | null> {
    const csMembers = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.role, "CUSTOMER_SUPPORT"),
        ),
      );

    if (csMembers.length === 0) return null;

    const memberIds = csMembers.map((m) => m.userId);
    const grouped = await this.db
      .select({ userId: clientAccounts.assignedCrmId, load: count() })
      .from(clientAccounts)
      .where(
        and(
          eq(clientAccounts.orgId, orgId),
          inArray(clientAccounts.assignedCrmId, memberIds),
          sql`${clientAccounts.status} != 'INVESTED'`,
        ),
      )
      .groupBy(clientAccounts.assignedCrmId);

    const loadByUser = new Map<string, number>();
    for (const row of grouped) {
      if (row.userId) loadByUser.set(row.userId, Number(row.load));
    }

    let minCount = Infinity;
    let assignee: string | null = null;
    for (const m of csMembers) {
      const load = loadByUser.get(m.userId) ?? 0;
      if (load < minCount) {
        minCount = load;
        assignee = m.userId;
      }
    }
    return assignee;
  }

  private async ensureDealForLead(orgId: string, lead: LeadRow): Promise<void> {
    const existingDeal = await this.db.query.deals.findFirst({
      where: and(eq(deals.leadId, lead.id), eq(deals.orgId, orgId)),
    });
    if (existingDeal) return;
    await this.db.insert(deals).values({
      orgId,
      leadId: lead.id,
      name: `${lead.name}${lead.company ? " - " + lead.company : ""}`,
      value: lead.potentialValue || lead.investmentInterest || "0",
      stage: "LEAD",
      contactPerson: lead.name,
      contactEmail: lead.email,
      contactPhone: lead.phone,
      assignedToId: null,
    });
  }

  private async convertLeadToClient(
    orgId: string,
    userId: string,
    lead: LeadRow,
    input: TransitionLeadStatusInput,
    crmAssigneeId: string | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existingClient = await tx.query.clients.findFirst({
        where: and(eq(clients.leadId, lead.id), eq(clients.orgId, orgId)),
      });
      if (!existingClient) {
        await tx.insert(clients).values({
          orgId,
          leadId: lead.id,
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          company: lead.company,
          designation: lead.designation,
          city: lead.city,
          investmentValue: lead.potentialValue,
          accountManagerId: lead.assignedToId,
          status: "active",
        });
      }

      const existingClientAccount = await tx.query.clientAccounts.findFirst({
        where: and(
          eq(clientAccounts.leadId, lead.id),
          eq(clientAccounts.orgId, orgId),
        ),
      });
      if (!existingClientAccount) {
        await tx.insert(clientAccounts).values({
          orgId,
          leadId: lead.id,
          salesRepId: lead.assignedToId ?? userId,
          assignedCrmId: crmAssigneeId,
          clientName: lead.name,
          clientEmail: lead.email,
          clientPhone: lead.phone,
          clientWhatsapp: lead.whatsappNumber,
          estimatedInvestment:
            input.estimatedInvestment ||
            lead.potentialValue ||
            lead.investmentInterest ||
            null,
          status: "ACCOUNT_OPENING",
          convertedAt: new Date(),
        });
      }

      if (input.conversionNotes || input.estimatedInvestment) {
        await tx
          .update(leads)
          .set({
            ...(input.conversionNotes ? { notes: input.conversionNotes } : {}),
            ...(input.estimatedInvestment
              ? {
                  potentialValue: input.estimatedInvestment,
                  investmentInterest: input.estimatedInvestment,
                }
              : {}),
          })
          .where(eq(leads.id, lead.id));
      }
    });
  }

  private async dispatchConversionSideEffects(
    orgId: string,
    userId: string,
    lead: LeadRow,
    crmAssigneeId: string | null,
  ): Promise<void> {
    try {
      const firstProject = await this.db.query.projects.findFirst({
        where: eq(projects.orgId, orgId),
      });
      if (firstProject) {
        const ticketCountResult = await this.db
          .select({ count: count() })
          .from(tickets)
          .where(eq(tickets.projectId, firstProject.id));
        const nextTicketNumber = (ticketCountResult[0]?.count ?? 0) + 1;

        await this.db.insert(tickets).values({
          orgId,
          title: `Onboard converted lead: ${lead.name}`,
          description: `Lead "${lead.name}" has been converted.\nCompany: ${lead.company || "N/A"}\nEmail: ${lead.email || "N/A"}\nPhone: ${lead.phone || "N/A"}`,
          type: "TASK",
          status: "TODO",
          priority: "HIGH",
          projectId: firstProject.id,
          ticketNumber: nextTicketNumber,
          reporterId: userId,
        });
      }

      await this.dispatch.emit({
        eventKey: "crm.lead.converted",
        orgId,
        actorUserId: userId,
        targetUserIds: [lead.assignedToId || userId],
        entityType: "lead",
        entityId: String(lead.id),
        title: "Lead Converted",
        message: `Lead "${lead.name}" has been converted to a client.${crmAssigneeId ? " A CRM executive has been assigned." : ""}`,
        link: `/crm/clients`,
      });

      if (crmAssigneeId)
        await this.dispatch.emit({
          eventKey: "crm.client.assigned",
          orgId,
          actorUserId: userId,
          targetUserIds: [crmAssigneeId],
          entityType: "lead",
          entityId: String(lead.id),
          title: "New Client Assigned",
          message: `Client "${lead.name}" has been assigned to you for onboarding. Estimated investment: ${lead.potentialValue ?? "N/A"}.`,
          link: `/crm/clients`,
        });

      const salesRep = await this.db.query.users.findFirst({
        where: eq(users.id, lead.assignedToId || userId),
        columns: { email: true, name: true },
      });
      if (salesRep?.email) {
        const { subject, html } = getLeadStatusChangeEmailTemplate({
          recipientName: salesRep.name ?? "Team Member",
          leadName: lead.name,
          fromStatus: null,
          toStatus: "Converted",
          leadUrl: `${appUrl}/crm/clients`,
        });
        await this.email.sendEmail({ to: salesRep.email, subject, html });
      }

      if (crmAssigneeId) {
        const crmUser = await this.db.query.users.findFirst({
          where: eq(users.id, crmAssigneeId),
          columns: { email: true, name: true },
        });
        if (crmUser?.email) {
          const { subject, html } = getLeadStatusChangeEmailTemplate({
            recipientName: crmUser.name ?? "Team Member",
            leadName: lead.name,
            fromStatus: null,
            toStatus: "Converted",
            leadUrl: `${appUrl}/crm/clients`,
          });
          await this.email.sendEmail({ to: crmUser.email, subject, html });
        }
      }
    } catch {
      return;
    }
  }

  async transitionLeadStatus(
    orgId: string,
    userId: string,
    leadId: number,
    input: TransitionLeadStatusInput,
  ): Promise<TransitionLeadStatusResult> {
    if (input.status === "CONVERTED") {
      const existing = await this.db.query.leads.findFirst({
        where: and(eq(leads.id, leadId), eq(leads.orgId, orgId)),
        columns: { status: true },
      });
      if (existing?.status === "CONVERTED") {
        return { ok: false, reason: "already_converted" };
      }
    }

    const updateData: Partial<typeof leads.$inferInsert> = {
      status: input.status,
      updatedAt: new Date(),
    };
    if (input.status === "CONVERTED") updateData.convertedAt = new Date();
    if (input.status === "LOST" && input.lostReason)
      updateData.lostReason = input.lostReason;

    const conditions = [eq(leads.id, leadId), eq(leads.orgId, orgId)];
    if (input.expectedStatus)
      conditions.push(eq(leads.status, input.expectedStatus));

    const [updated] = await this.db
      .update(leads)
      .set(updateData)
      .where(and(...conditions))
      .returning();

    if (!updated) return { ok: false, reason: "stale_or_missing" };

    if (input.status === "INTERESTED" || input.status === "QUALIFIED") {
      await this.ensureDealForLead(orgId, updated);
    }

    if (input.status === "CONVERTED") {
      const crmAssigneeId = await this.getNextCrmAssignee(orgId);
      await this.convertLeadToClient(
        orgId,
        userId,
        updated,
        input,
        crmAssigneeId,
      );
      void this.dispatchConversionSideEffects(
        orgId,
        userId,
        updated,
        crmAssigneeId,
      );
    }

    return { ok: true, lead: updated };
  }

  async changeStatus(
    orgId: string,
    userId: string,
    leadId: number,
    input: TransitionLeadStatusInput,
  ): Promise<TransitionLeadStatusResult> {
    const result = await this.transitionLeadStatus(
      orgId,
      userId,
      leadId,
      input,
    );
    if (!result.ok) return result;

    await this.cache.invalidatePattern(`leads:*:${orgId}:*`);
    await this.cache.invalidate(CACHE_KEYS.salesDashboard(orgId));

    this.audit.log({
      action: "lead.status_changed",
      userId,
      orgId,
      targetId: String(leadId),
      targetType: "lead",
      metadata: { newStatus: input.status, lostReason: input.lostReason },
    });

    return result;
  }
}
