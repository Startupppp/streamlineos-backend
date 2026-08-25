import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  clientAccounts,
  clientPartyMap,
  projects,
  tickets,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../db/drizzle.types";
import { logger } from "../../common/logger/logger.service";
import { AccessService } from "../access/access.service";
import { EmailService } from "../email/email.service";
import { appUrl } from "../email/app-url";
import { getLeadStatusChangeEmailTemplate } from "../email/templates/crm";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import type { TransitionLeadStatusInput } from "./dto/lead-mutations.schemas";
import { updateMirroredLeads } from "../party/party-legacy-leads";
import { createMirroredClient, updateMirroredClient } from "../party/party-legacy-clients";
import { isLegacyResolved, resolveLegacyParty } from "../party/party-legacy-seam";
import { PartyMergeService } from "../party/party-merge.service";
import type { LeadRow } from "../party/party-legacy-writer";

/**
 * What happens when a lead becomes a customer.
 *
 * Split out of `lead-status.service.ts` by this batch: deciding whether a
 * transition is allowed is one job, and standing up the client, the account, the
 * onboarding ticket and the notifications behind it is another — and the second
 * one grew when conversion stopped being allowed to leave two Party records
 * behind.
 */
@Injectable()
export class LeadConversionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly dispatch: NotificationDispatchService,
    private readonly email: EmailService,
    private readonly merges: PartyMergeService,
  ) {}

  /**
   * The whole conversion: the client, its account, and the people to tell.
   *
   * The side effects are deliberately not awaited, exactly as they were before
   * the split — an onboarding ticket that cannot be written must not fail the
   * status change that has already happened.
   */
  async convert(
    orgId: string,
    userId: string,
    lead: LeadRow,
    input: TransitionLeadStatusInput,
  ): Promise<void> {
    const crmAssigneeId = await this.getNextCrmAssignee(orgId);
    await this.convertLeadToClient(orgId, userId, lead, input, crmAssigneeId);
    void this.dispatchConversionSideEffects(orgId, userId, lead, crmAssigneeId);
  }

  private async getNextCrmAssignee(orgId: string): Promise<string | null> {
    const csMembers = await this.access.membersWithPermission(orgId, "support:tickets:manage");

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

  /**
   * Whether this lead has already become a client.
   *
   * Asked of Party rather than of `clients.lead_id`: after the collapse below,
   * the lead and the client are one party, so the client ids that party answers
   * for *are* the clients this lead became. The legacy column is still written
   * for the modules that have not migrated, but it is no longer what decides.
   */
  private async alreadyAClient(
    tx: TenantTx,
    orgId: string,
    leadPartyId: string,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ clientId: clientPartyMap.clientId })
      .from(clientPartyMap)
      .where(
        and(
          eq(clientPartyMap.organizationId, orgId),
          eq(clientPartyMap.partyId, leadPartyId),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  private async convertLeadToClient(
    orgId: string,
    userId: string,
    lead: LeadRow,
    input: TransitionLeadStatusInput,
    crmAssigneeId: string | null,
  ): Promise<void> {
    const leadParty = await resolveLegacyParty(this.db, orgId, {
      kind: "LEAD",
      legacyId: lead.id,
    });

    const createdClientId = await this.db.transaction(async (tx) => {
      const alreadyClient =
        isLegacyResolved(leadParty) &&
        (await this.alreadyAClient(tx, orgId, leadParty.party.partyId));

      let clientId: number | null = null;
      if (!alreadyClient) {
        const client = await createMirroredClient(
          tx,
          orgId,
          {
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
          },
          { linkedBy: "leads:convert" },
        );
        clientId = client.id;
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
        await updateMirroredLeads(tx, orgId, [lead.id], {
          ...(input.conversionNotes ? { notes: input.conversionNotes } : {}),
          ...(input.estimatedInvestment
            ? {
                potentialValue: input.estimatedInvestment,
                investmentInterest: input.estimatedInvestment,
              }
            : {}),
        });
      }

      return clientId;
    });

    if (createdClientId !== null && isLegacyResolved(leadParty))
      await this.collapseOntoLeadParty(
        orgId,
        userId,
        leadParty.party.partyId,
        createdClientId,
        lead.potentialValue ?? null,
      );
  }

  /**
   * One Party for the relationship, not one per label it has worn.
   *
   * `createMirroredClient` always inserts a new party, because inserting one is
   * the only way `clients` has to acquire a Party at all. So a conversion
   * momentarily produces a second record for somebody who already has one, and
   * this collapses it back — as a *merge* rather than an UPDATE, because
   * `PartyMergeService` snapshots both rows, re-points the client's legacy id
   * onto the survivor, records who decided it and can put the pair back. A
   * hand-written re-point would do the visible half of that and none of the rest.
   *
   * The survivor is the lead's own party: `chooseSurvivor` keeps the older of the
   * two, and a lead necessarily exists before the transition that converts it.
   *
   * Called after the transaction that created the client, not inside it: the
   * merge service works on the ambient tenant handle rather than a `tx` passed
   * down, and inside a nested transaction its reads would be looking for a client
   * row that has not been committed yet.
   */
  private async collapseOntoLeadParty(
    orgId: string,
    userId: string,
    leadPartyId: string,
    clientId: number,
    investmentValue: string | null,
  ): Promise<void> {
    try {
      const clientParty = await resolveLegacyParty(this.db, orgId, {
        kind: "CLIENT",
        legacyId: clientId,
      });
      if (!isLegacyResolved(clientParty)) return;
      if (clientParty.party.partyId === leadPartyId) return;

      const outcome = await this.merges.merge(orgId, {
        leftPartyId: leadPartyId,
        rightPartyId: clientParty.party.partyId,
        decidedBy: "USER",
        userId,
      });

      if (outcome.survivorPartyId !== leadPartyId)
        logger.error("Lead conversion kept the client's party, not the lead's", {
          orgId,
          leadPartyId,
          survivorPartyId: outcome.survivorPartyId,
        });

      // `planMerge` carries name, email, phone and notes across and deliberately
      // nothing else, so the survivor keeps its own `lifetime_value` — which is
      // null, because a lead has an expected value and not a lifetime one. Re-
      // applied through the client writer so the legacy row is still derived in
      // exactly one place.
      if (investmentValue !== null)
        await updateMirroredClient(this.db, orgId, clientId, {
          investmentValue,
        });
    } catch (error) {
      // Not fatal to the conversion: the status change is already committed and
      // the client already exists, so throwing would report a failure for work
      // that succeeded. The pair is left for the duplicate detector, and this
      // line is how anyone knows to look.
      logger.error("Failed to collapse a converted lead onto one party", {
        orgId,
        leadPartyId,
        clientId,
        error,
      });
    }
  }

  private async dispatchConversionSideEffects(
    orgId: string,
    userId: string,
    lead: LeadRow,
    crmAssigneeId: string | null,
  ): Promise<void> {
    try {
      const firstProject = await this.db.query.projects.findFirst({
        where: and(eq(projects.orgId, orgId), isNull(projects.deletedAt)),
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

      const salesRepId = lead.assignedToId || userId;
      const idsToFetch = [...new Set([salesRepId, ...(crmAssigneeId ? [crmAssigneeId] : [])])];
      const userRows = await this.db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(inArray(users.id, idsToFetch));
      const userMap = new Map(userRows.map((u) => [u.id, u]));

      const salesRep = userMap.get(salesRepId);
      if (salesRep?.email) {
        const { subject, html } = getLeadStatusChangeEmailTemplate({
          recipientName: salesRep.name ?? "Team Member",
          leadName: lead.name,
          fromStatus: null,
          toStatus: "Converted",
          leadUrl: `${appUrl()}/crm/clients`,
        });
        await this.email.sendEmail({ to: salesRep.email, subject, html });
      }

      if (crmAssigneeId) {
        const crmUser = userMap.get(crmAssigneeId);
        if (crmUser?.email) {
          const { subject, html } = getLeadStatusChangeEmailTemplate({
            recipientName: crmUser.name ?? "Team Member",
            leadName: lead.name,
            fromStatus: null,
            toStatus: "Converted",
            leadUrl: `${appUrl()}/crm/clients`,
          });
          await this.email.sendEmail({ to: crmUser.email, subject, html });
        }
      }
    } catch {
      return;
    }
  }
}
