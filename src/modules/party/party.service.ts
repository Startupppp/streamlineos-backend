import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, ilike, isNull, or } from "drizzle-orm";
import { businessParties, partyContacts } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import type {
  ListPartiesQuery,
  CreatePartyInput,
  UpdatePartyInput,
  CreateContactInput,
  UpdateContactInput,
} from "./dto/party.schemas";

const PG_UNIQUE_VIOLATION = "23505";

type PartyRow = typeof businessParties.$inferSelect;
type PartyPatch = Partial<typeof businessParties.$inferInsert>;
type ContactRow = typeof partyContacts.$inferSelect;
type ContactPatch = Partial<typeof partyContacts.$inferInsert>;

@Injectable()
export class PartyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async loadParty(organizationId: string, partyId: string): Promise<PartyRow> {
    const [row] = await this.db
      .select()
      .from(businessParties)
      .where(
        and(
          eq(businessParties.partyId, partyId),
          eq(businessParties.organizationId, organizationId),
          isNull(businessParties.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Party not found");
    return row;
  }

  private async loadContact(organizationId: string, partyContactId: string): Promise<ContactRow> {
    const [row] = await this.db
      .select()
      .from(partyContacts)
      .where(
        and(
          eq(partyContacts.partyContactId, partyContactId),
          eq(partyContacts.organizationId, organizationId),
          isNull(partyContacts.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Contact not found");
    return row;
  }

  async listParties(organizationId: string, query: ListPartiesQuery) {
    const { page, limit, partyType, search } = query;
    const offset = (page - 1) * limit;

    const searchCondition = search
      ? or(
          ilike(businessParties.name, `%${search}%`),
          ilike(businessParties.legalName, `%${search}%`),
          ilike(businessParties.email, `%${search}%`),
        )
      : undefined;

    const conditions = and(
      eq(businessParties.organizationId, organizationId),
      isNull(businessParties.deletedAt),
      partyType ? eq(businessParties.partyType, partyType) : undefined,
      searchCondition,
    );

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select()
        .from(businessParties)
        .where(conditions)
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(businessParties).where(conditions),
    ]);

    const total = Number(totalRow?.total ?? 0);
    return {
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getParty(organizationId: string, partyId: string) {
    return this.loadParty(organizationId, partyId);
  }

  async createParty(organizationId: string, userId: string, input: CreatePartyInput) {
    const [row] = await this.db
      .insert(businessParties)
      .values({
        organizationId,
        name: input.name,
        partyType: input.partyType ?? "CUSTOMER",
        legalName: input.legalName ?? null,
        displayName: input.displayName ?? null,
        taxNumber: input.taxNumber ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        website: input.website ?? null,
        notes: input.notes ?? null,
      })
      .returning()
      .catch((err: unknown) => {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === PG_UNIQUE_VIOLATION
        ) {
          throw new ConflictException("A party with this identifier already exists in this organization.");
        }
        throw err;
      });
    if (!row) throw new NotFoundException("Failed to create party");
    this.audit.log({
      action: "party.party.created",
      userId,
      orgId: organizationId,
      resourceType: "business_party",
      resourceId: row.partyId,
      metadata: { partyId: row.partyId, name: row.name },
    });
    return row;
  }

  async updateParty(
    organizationId: string,
    userId: string,
    partyId: string,
    input: UpdatePartyInput,
  ) {
    await this.loadParty(organizationId, partyId);

    const patch: PartyPatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.partyType !== undefined) patch.partyType = input.partyType;
    if (input.legalName !== undefined) patch.legalName = input.legalName ?? null;
    if (input.displayName !== undefined) patch.displayName = input.displayName ?? null;
    if (input.taxNumber !== undefined) patch.taxNumber = input.taxNumber ?? null;
    if (input.email !== undefined) patch.email = input.email ?? null;
    if (input.phone !== undefined) patch.phone = input.phone ?? null;
    if (input.website !== undefined) patch.website = input.website ?? null;
    if (input.notes !== undefined) patch.notes = input.notes ?? null;
    if (input.status !== undefined) patch.status = input.status;

    const [updated] = await this.db
      .update(businessParties)
      .set(patch)
      .where(
        and(
          eq(businessParties.partyId, partyId),
          eq(businessParties.organizationId, organizationId),
        ),
      )
      .returning()
      .catch((err: unknown) => {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === PG_UNIQUE_VIOLATION
        ) {
          throw new ConflictException("A party with this identifier already exists in this organization.");
        }
        throw err;
      });
    if (!updated) throw new NotFoundException("Party not found");
    this.audit.log({
      action: "party.party.updated",
      userId,
      orgId: organizationId,
      resourceType: "business_party",
      resourceId: partyId,
      metadata: { partyId },
    });
    return updated;
  }

  async softDeleteParty(organizationId: string, userId: string, partyId: string) {
    await this.loadParty(organizationId, partyId);
    await this.db
      .update(businessParties)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(businessParties.partyId, partyId),
          eq(businessParties.organizationId, organizationId),
        ),
      );
    this.audit.log({
      action: "party.party.deleted",
      userId,
      orgId: organizationId,
      resourceType: "business_party",
      resourceId: partyId,
      metadata: { partyId },
    });
  }

  async listContacts(organizationId: string, partyId: string) {
    await this.loadParty(organizationId, partyId);
    return this.db
      .select()
      .from(partyContacts)
      .where(
        and(
          eq(partyContacts.organizationId, organizationId),
          eq(partyContacts.partyId, partyId),
          isNull(partyContacts.deletedAt),
        ),
      );
  }

  async createContact(organizationId: string, userId: string, input: CreateContactInput) {
    await this.loadParty(organizationId, input.partyId);

    const [row] = await this.db
      .insert(partyContacts)
      .values({
        organizationId,
        partyId: input.partyId,
        firstName: input.firstName,
        lastName: input.lastName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        title: input.title ?? null,
        isPrimary: input.isPrimary ?? false,
      })
      .returning()
      .catch((err: unknown) => {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === PG_UNIQUE_VIOLATION
        ) {
          throw new ConflictException("A contact with this identifier already exists.");
        }
        throw err;
      });
    if (!row) throw new NotFoundException("Failed to create contact");
    this.audit.log({
      action: "party.contact.created",
      userId,
      orgId: organizationId,
      resourceType: "party_contact",
      resourceId: row.partyContactId,
      metadata: { partyContactId: row.partyContactId, partyId: row.partyId },
    });
    return row;
  }

  async updateContact(
    organizationId: string,
    userId: string,
    partyContactId: string,
    input: UpdateContactInput,
  ) {
    await this.loadContact(organizationId, partyContactId);

    const patch: ContactPatch = {};
    if (input.firstName !== undefined) patch.firstName = input.firstName;
    if (input.lastName !== undefined) patch.lastName = input.lastName ?? null;
    if (input.email !== undefined) patch.email = input.email ?? null;
    if (input.phone !== undefined) patch.phone = input.phone ?? null;
    if (input.title !== undefined) patch.title = input.title ?? null;
    if (input.isPrimary !== undefined) patch.isPrimary = input.isPrimary;

    const [updated] = await this.db
      .update(partyContacts)
      .set(patch)
      .where(
        and(
          eq(partyContacts.partyContactId, partyContactId),
          eq(partyContacts.organizationId, organizationId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Contact not found");
    this.audit.log({
      action: "party.contact.updated",
      userId,
      orgId: organizationId,
      resourceType: "party_contact",
      resourceId: partyContactId,
      metadata: { partyContactId },
    });
    return updated;
  }

  async softDeleteContact(organizationId: string, userId: string, partyContactId: string) {
    await this.loadContact(organizationId, partyContactId);
    await this.db
      .update(partyContacts)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(partyContacts.partyContactId, partyContactId),
          eq(partyContacts.organizationId, organizationId),
        ),
      );
    this.audit.log({
      action: "party.contact.deleted",
      userId,
      orgId: organizationId,
      resourceType: "party_contact",
      resourceId: partyContactId,
      metadata: { partyContactId },
    });
  }
}
