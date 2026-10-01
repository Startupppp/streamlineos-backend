import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  clientAccounts,
  clientPartyMap,
  projects,
  tickets,
} from "../../db/schema";
import { BuildTicketCreationService } from "../build/core/tickets";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../db/drizzle.types";
import { logger } from "../../common/logger/logger.service";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { AccessService } from "../access/access.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import type { TransitionLeadStatusInput } from "./dto/lead-mutations.schemas";
import { updateMirroredLeads } from "../party/party-legacy-leads";
import {
  createMirroredClient,
  updateMirroredClient,
} from "../party/party-legacy-clients";
import {
  isLegacyResolved,
  resolveLegacyParty,
} from "../party/party-legacy-seam";
import { PartyMergeService } from "../party/party-merge.service";
import type { LeadRow } from "../party/party-legacy-writer";

@Injectable()
export class LeadConversionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly dispatch: NotificationDispatchService,
    private readonly merges: PartyMergeService,
    private readonly ticketCreation: BuildTicketCreationService,
  ) {}

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
    const csMembers = await this.access.membersWithPermission(
      orgId,
      "support:tickets:manage",
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

      // Only its absence is read, and a client account carries the customer's
      // name, email and phone — no reason to hydrate them to answer "any?".
      const existingClientAccount = await tx.query.clientAccounts.findFirst({
        where: and(
          eq(clientAccounts.leadId, lead.id),
          eq(clientAccounts.orgId, orgId),
        ),
        columns: { id: true },
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
        logger.error(
          "Lead conversion kept the client's party, not the lead's",
          {
            orgId,
            leadPartyId,
            survivorPartyId: outcome.survivorPartyId,
          },
        );

      if (investmentValue !== null)
        await updateMirroredClient(this.db, orgId, clientId, {
          investmentValue,
        });
    } catch (error) {
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
        const existingOnboardTicket = await this.db.query.tickets.findFirst({
          where: and(
            eq(tickets.projectId, firstProject.id),
            eq(tickets.orgId, orgId),
            eq(tickets.title, `Onboard converted lead: ${lead.name}`),
          ),
          columns: { id: true },
        });
        if (!existingOnboardTicket) {
          await this.ticketCreation.create({
            orgId,
            projectId: firstProject.id,
            actor: { userId, membershipId: null },
            drafts: [
              {
                title: `Onboard converted lead: ${lead.name}`,
                description: `Lead "${lead.name}" has been converted.\nCompany: ${lead.company || "N/A"}\nEmail: ${lead.email || "N/A"}\nPhone: ${lead.phone || "N/A"}`,
                type: "TASK",
                status: "TODO",
                priority: "HIGH",
                reporterId: userId,
              },
            ],
          });
        }
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
    } catch (err) {
      logSideEffectFailure("conversion notification emails", {
        orgId,
        leadId: lead.id,
      })(err);
      return;
    }
  }
}
