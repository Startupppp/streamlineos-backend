import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, exists, ilike, isNull, or, sql } from "drizzle-orm";
import { keysetBefore } from "../../common/pagination/keyset";
import { businessParties, partyContacts, partyRoles } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { isUniqueViolation } from "../../common/db/postgres-error";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { softDeletePartyWithMirror, updatePartyWithMirror } from "./party-legacy-writer";
import { claimIdentifiers, identifierClaimsOfColumns } from "./party-identifiers";
import type {
  ListPartiesQuery,
  CreatePartyInput,
  UpdatePartyInput,
  CreateContactInput,
  UpdateContactInput,
} from "./dto/party.schemas";

type PartyRow = typeof businessParties.$inferSelect;
type PartyPatch = Partial<typeof businessParties.$inferInsert>;
type ContactRow = typeof partyContacts.$inferSelect;
type ContactPatch = Partial<typeof partyContacts.$inferInsert>;

/**
 * One shape for both paging strategies.
 *
 * `total` and `totalPages` are optional because the cursor branch deliberately
 * skips the count query — on a large tenant that count is the expensive half of
 * the request, and a keyset reader does not need it.
 */
interface PartyListPage {
  data: PartyRow[];
  pagination: {
    page: number;
    limit: number;
    total?: number;
    totalPages?: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
}

@Injectable()
export class PartyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  /**
   * Companies are shown on two routes, so a write here invalidates both.
   *
   * Since ticket 25 `/crm/organizations` IS this list filtered by
   * `party_kind = 'ORGANISATION'`, and that list is cached under the CRM
   * namespaces. Editing a company through the Party surface without bumping them
   * would leave the Companies screen showing the old name -- which is precisely
   * the "two surfaces disagree" symptom the convergence exists to remove, put
   * back by a cache instead of by a table.
   *
   * Takes both the before and after rows: demoting a party out of ORGANISATION
   * has to clear the list it is leaving, not the one it is joining.
   */
  private async invalidateCompanySurfaces(
    organizationId: string,
    ...parties: readonly (PartyRow | undefined)[]
  ): Promise<void> {
    if (!parties.some((party) => party?.partyKind === "ORGANISATION")) return;
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.crmOrganizationsListNamespace(organizationId)),
      this.cache.invalidateNamespace(CACHE_KEYS.crmOrganizationDetailNamespace(organizationId)),
    ]);
  }

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

  async listParties(organizationId: string, query: ListPartiesQuery): Promise<PartyListPage> {
    const { page, limit, partyType, partyKind, search, cursor, role } = query;
    const position = decodeCursor(cursor);

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
      partyKind ? eq(businessParties.partyKind, partyKind) : undefined,
      // A semi-join rather than a join: a party holding a role twice must not
      // appear twice in the list.
      role
        ? exists(
            this.db
              .select({ one: sql`1` })
              .from(partyRoles)
              .where(
                and(
                  eq(partyRoles.organizationId, businessParties.organizationId),
                  eq(partyRoles.partyId, businessParties.partyId),
                  eq(partyRoles.role, role),
                  isNull(partyRoles.removedAt),
                ),
              ),
          )
        : undefined,
      searchCondition,
    );

    if (position) {
      // Row-value comparison, matching the index order exactly, so the scan
      // starts at the cursor instead of reading and discarding earlier rows.
      const keyset = and(
        conditions,
        keysetBefore(businessParties.createdAt, businessParties.partyId, position),
      );

      const rows = await this.db
        .select()
        .from(businessParties)
        .where(keyset)
        .orderBy(desc(businessParties.createdAt), desc(businessParties.partyId))
        .limit(limit + 1);

      const keysetPage = buildCursorPage(rows, limit, (row) => ({
        sortValue: row.createdAt.toISOString(),
        id: row.partyId,
      }));

      return {
        data: keysetPage.data,
        pagination: { page, ...keysetPage.pagination },
      };
    }

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select()
        .from(businessParties)
        .where(conditions)
        .orderBy(desc(businessParties.createdAt), desc(businessParties.partyId))
        .limit(limit + 1),
      this.db.select({ total: count() }).from(businessParties).where(conditions),
    ]);

    const total = Number(totalRow?.total ?? 0);
    const cursorPage = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: row.partyId,
    }));

    // Both shapes: existing callers keep their page numbers, and a caller that
    // wants stable scrolling can follow nextCursor from the first response.
    return {
      data: cursorPage.data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        nextCursor: cursorPage.pagination.nextCursor,
        hasMore: cursorPage.pagination.hasMore,
      },
    };
  }

  async getParty(organizationId: string, partyId: string) {
    return this.loadParty(organizationId, partyId);
  }

  async createParty(organizationId: string, userId: string, input: CreatePartyInput) {
    /**
     * The human path's share of ticket 07.
     *
     * The ticket is about autonomous writers, and closing only that half would
     * have left the odd position that a plan limit binds the robot and not the
     * person -- so the same record, created by hand, was unbounded. This is the
     * ordinary throwing assertion every other write path in the platform uses,
     * because here there *is* somebody to be told.
     */
    await this.planLimits.assertWithinLimit(organizationId, "crmContacts");

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
        partyKind: input.partyKind ?? null,
        employerPartyId: input.employerPartyId ?? null,
      })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) {
          throw new ConflictException("A party with this identifier already exists in this organization.");
        }
        throw err;
      });
    if (!row) throw new NotFoundException("Failed to create party");

    /**
     * Reachable from the moment it exists.
     *
     * `this.db` is the request's transaction, so the party and its identifiers
     * commit together — a party with no identifier is one the next message from
     * that customer would not match, and they would become a second record.
     */
    await claimIdentifiers(this.db, organizationId, row.partyId, identifierClaimsOfColumns(row));
    await this.invalidateCompanySurfaces(organizationId, row);

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
    const before = await this.loadParty(organizationId, partyId);

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
    /**
     * CRM-P1-09. Null clears it back to "unknown", which is a real answer —
     * send-time working hours then fall through to the tenant's zone rather
     * than keeping a value somebody has decided is wrong.
     */
    if (input.timezone !== undefined) patch.timezone = input.timezone ?? null;
    if (input.partyKind !== undefined) patch.partyKind = input.partyKind ?? null;
    // Reaches `contacts.organization_id` through the writer, which translates it
    // back into a `crm_organizations` id: see `party-legacy-employer.ts`.
    if (input.employerPartyId !== undefined)
      patch.employerPartyId = input.employerPartyId ?? null;

    // Through the writer, not straight at the table: the party is the canonical
    // record and every `leads`/`clients`/`contacts` row mapped to it is a mirror
    // that has to move with it, in the same transaction.
    const updated = await updatePartyWithMirror(this.db, organizationId, partyId, patch).catch(
      (err: unknown) => {
        if (isUniqueViolation(err)) {
          throw new ConflictException("A party with this identifier already exists in this organization.");
        }
        throw err;
      },
    );
    await this.invalidateCompanySurfaces(organizationId, before, updated);
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
    const party = await this.loadParty(organizationId, partyId);
    await softDeletePartyWithMirror(this.db, organizationId, partyId);
    await this.invalidateCompanySurfaces(organizationId, party);
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
        if (isUniqueViolation(err)) {
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
    const existing = await this.loadContact(organizationId, partyContactId);

    const patch: ContactPatch = {};
    if (input.firstName !== undefined) patch.firstName = input.firstName;
    if (input.lastName !== undefined) patch.lastName = input.lastName ?? null;
    if (input.email !== undefined) patch.email = input.email ?? null;
    if (input.phone !== undefined) patch.phone = input.phone ?? null;
    if (input.title !== undefined) patch.title = input.title ?? null;
    if (input.isPrimary !== undefined) patch.isPrimary = input.isPrimary;

    if (Object.keys(patch).length === 0) return existing;

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
