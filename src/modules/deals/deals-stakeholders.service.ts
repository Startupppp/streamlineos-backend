import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { crmDealStakeholders, deals } from "../../db/schema";
import { businessParties, contactPartyMap } from "../../db/schema/party";
import { PARTY_OF_CONTACT } from "../crm/crm-party-reads";
import { isLegacyResolved, resolveLegacyParty } from "../party/party-legacy-seam";

export interface CreateStakeholderInput {
  contactId: number;
  roleKey?: string | null;
  influence?: string | null;
  isPrimary?: boolean;
  notes?: string | null;
}

export interface UpdateStakeholderInput {
  roleKey?: string | null;
  influence?: string | null;
  isPrimary?: boolean;
  notes?: string | null;
}

@Injectable()
export class DealsStakeholdersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertDealBelongsToOrg(orgId: string, dealId: number): Promise<void> {
    const deal = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)),
      columns: { id: true },
    });
    if (!deal) throw new NotFoundException("Deal not found");
  }

  async listStakeholders(orgId: string, dealId: number) {
    await this.assertDealBelongsToOrg(orgId, dealId);
    return this.db
      .select({
        id: crmDealStakeholders.id,
        dealId: crmDealStakeholders.dealId,
        contactId: crmDealStakeholders.contactId,
        roleKey: crmDealStakeholders.roleKey,
        influence: crmDealStakeholders.influence,
        isPrimary: crmDealStakeholders.isPrimary,
        notes: crmDealStakeholders.notes,
        createdAt: crmDealStakeholders.createdAt,
        contact: {
          id: contactPartyMap.contactId,
          name: businessParties.name,
          email: businessParties.email,
          title: businessParties.jobTitle,
          company: businessParties.companyName,
        },
      })
      .from(crmDealStakeholders)
      /*
       * The tenant is carried on both sides of both joins. The old join was
       * `contacts.id = stakeholder.contact_id` and nothing else, so a stakeholder
       * row holding another organisation's contact id rendered that contact's
       * name, address and employer -- `contacts.id` is a global serial, and the
       * only thing standing behind it was the check `createStakeholder` makes at
       * write time.
       */
      .innerJoin(
        contactPartyMap,
        and(
          eq(contactPartyMap.contactId, crmDealStakeholders.contactId),
          eq(contactPartyMap.organizationId, crmDealStakeholders.orgId),
        ),
      )
      .innerJoin(businessParties, PARTY_OF_CONTACT)
      .where(and(eq(crmDealStakeholders.orgId, orgId), eq(crmDealStakeholders.dealId, dealId)))
      // A `LIMIT` with no `ORDER BY` returned an arbitrary hundred of whatever
      // the heap handed back, and reading through the map changes that order.
      // `id` is the unique tiebreaker `created_at` alone does not give.
      .orderBy(asc(crmDealStakeholders.createdAt), asc(crmDealStakeholders.id))
      .limit(100);
  }

  async getOne(orgId: string, dealId: number, stakeholderId: string) {
    const rows = await this.db
      .select({
        id: crmDealStakeholders.id,
        dealId: crmDealStakeholders.dealId,
        contactId: crmDealStakeholders.contactId,
        roleKey: crmDealStakeholders.roleKey,
        influence: crmDealStakeholders.influence,
        isPrimary: crmDealStakeholders.isPrimary,
        notes: crmDealStakeholders.notes,
        createdAt: crmDealStakeholders.createdAt,
        contact: {
          id: contactPartyMap.contactId,
          name: businessParties.name,
          email: businessParties.email,
          title: businessParties.jobTitle,
          company: businessParties.companyName,
        },
      })
      .from(crmDealStakeholders)
      .innerJoin(
        contactPartyMap,
        and(
          eq(contactPartyMap.contactId, crmDealStakeholders.contactId),
          eq(contactPartyMap.organizationId, crmDealStakeholders.orgId),
        ),
      )
      .innerJoin(businessParties, PARTY_OF_CONTACT)
      .where(
        and(
          eq(crmDealStakeholders.id, stakeholderId),
          eq(crmDealStakeholders.dealId, dealId),
          eq(crmDealStakeholders.orgId, orgId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async createStakeholder(orgId: string, dealId: number, input: CreateStakeholderInput) {
    await this.assertDealBelongsToOrg(orgId, dealId);
    // Through the seam rather than `contacts`: the question is whether this
    // organisation has a record for that contact id, and the map is what answers
    // it once the legacy table is gone.
    const contact = await resolveLegacyParty(this.db, orgId, {
      kind: "CONTACT",
      legacyId: input.contactId,
    });
    if (!isLegacyResolved(contact))
      throw new BadRequestException("Contact not found in this organization");

    const [row] = await this.db
      .insert(crmDealStakeholders)
      .values({
        orgId,
        dealId,
        contactId: input.contactId,
        roleKey: input.roleKey ?? null,
        influence: input.influence ?? null,
        isPrimary: input.isPrimary ?? false,
        notes: input.notes ?? null,
      })
      .returning();
    return row;
  }

  async updateStakeholder(orgId: string, dealId: number, stakeholderId: string, input: UpdateStakeholderInput) {
    const existing = await this.db.query.crmDealStakeholders.findFirst({
      where: and(
        eq(crmDealStakeholders.id, stakeholderId),
        eq(crmDealStakeholders.dealId, dealId),
        eq(crmDealStakeholders.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Stakeholder not found");

    const [updated] = await this.db
      .update(crmDealStakeholders)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(crmDealStakeholders.id, stakeholderId), eq(crmDealStakeholders.orgId, orgId)))
      .returning();
    return updated;
  }

  async deleteStakeholder(orgId: string, dealId: number, stakeholderId: string) {
    const existing = await this.db.query.crmDealStakeholders.findFirst({
      where: and(
        eq(crmDealStakeholders.id, stakeholderId),
        eq(crmDealStakeholders.dealId, dealId),
        eq(crmDealStakeholders.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Stakeholder not found");
    await this.db
      .delete(crmDealStakeholders)
      .where(and(eq(crmDealStakeholders.id, stakeholderId), eq(crmDealStakeholders.orgId, orgId)));
    return { deleted: true };
  }
}
