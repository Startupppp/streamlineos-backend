import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { crmDealStakeholders, contacts, deals } from "../../db/schema";

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
          id: contacts.id,
          name: contacts.name,
          email: contacts.email,
          title: contacts.title,
          company: contacts.company,
        },
      })
      .from(crmDealStakeholders)
      .innerJoin(contacts, eq(contacts.id, crmDealStakeholders.contactId))
      .where(and(eq(crmDealStakeholders.orgId, orgId), eq(crmDealStakeholders.dealId, dealId)))
      .limit(100);
  }

  async createStakeholder(orgId: string, dealId: number, input: CreateStakeholderInput) {
    await this.assertDealBelongsToOrg(orgId, dealId);
    const contact = await this.db.query.contacts.findFirst({
      where: and(eq(contacts.id, input.contactId), eq(contacts.orgId, orgId)),
      columns: { id: true },
    });
    if (!contact) throw new BadRequestException("Contact not found in this organization");

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
