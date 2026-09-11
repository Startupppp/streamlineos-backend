import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { portalMemberships } from "../../../db/schema/portal-access/portal-memberships";
import { partyContacts } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { type PgUpdateSetSource } from "drizzle-orm/pg-core";
import { AuditService } from "../../../common/audit/audit.service";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import type {
  ListMembershipsQuery,
  CreateMembershipInput,
  UpdateMembershipStatusInput,
  ListGrantsQuery,
  CreateGrantInput,
  UpdateGrantInput,
} from "./dto/portal-access.schemas";
import {
  createGrant,
  listGrants,
  loadGrant,
  revokeGrant,
  updateGrant,
  type ProjectClientGrantDeps,
} from "./lib/project-client-grants";

/**
 * Portal access, which is two questions rather than one.
 *
 * A **membership** answers "does this contact have a portal login at all", and
 * lives here. A **grant** answers "and which project may they open once they
 * are in", and lives in `lib/project-client-grants.ts` — a different table, a
 * different DTO family and a different audit resource type. The dependency runs
 * one way only: creating a grant reads a membership to confirm it is ACTIVE,
 * and nothing here ever reads a grant. `loadMembership` is handed across that
 * line as a bound closure so it stays private and org-scoped.
 *
 * Both surfaces are external-facing: every route on `PortalAccessController`
 * sits behind `build:clientvisibility:manage` (or `build:portal:view` to read),
 * and every read here is filtered by `organizationId` in SQL rather than
 * trusting the caller's id — `portal-access-tenant-isolation.spec.ts` is what
 * holds that.
 */

type MembershipRow = typeof portalMemberships.$inferSelect;

@Injectable()
export class PortalAccessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private get grantDeps(): ProjectClientGrantDeps {
    return {
      db: this.db,
      audit: this.audit,
      loadMembership: (organizationId, portalMembershipId) =>
        this.loadMembership(organizationId, portalMembershipId),
    };
  }

  private async loadMembership(organizationId: string, portalMembershipId: string): Promise<MembershipRow> {
    const [row] = await this.db
      .select()
      .from(portalMemberships)
      .where(
        and(
          eq(portalMemberships.portalMembershipId, portalMembershipId),
          eq(portalMemberships.organizationId, organizationId),
          isNull(portalMemberships.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Portal membership not found");
    return row;
  }

  async listMemberships(organizationId: string, query: ListMembershipsQuery) {
    const { page, limit, status } = query;
    const offset = (page - 1) * limit;

    const conditions = and(
      eq(portalMemberships.organizationId, organizationId),
      isNull(portalMemberships.deletedAt),
      status ? eq(portalMemberships.status, status) : undefined,
    );

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select({
          portalMembershipId: portalMemberships.portalMembershipId,
          organizationId: portalMemberships.organizationId,
          audience: portalMemberships.audience,
          partyContactId: portalMemberships.partyContactId,
          userMembershipId: portalMemberships.userMembershipId,
          status: portalMemberships.status,
          sessionEpoch: portalMemberships.sessionEpoch,
          deletedAt: portalMemberships.deletedAt,
          createdAt: portalMemberships.createdAt,
          updatedAt: portalMemberships.updatedAt,
          contactFirstName: partyContacts.firstName,
          contactLastName: partyContacts.lastName,
        })
        .from(portalMemberships)
        .leftJoin(
          partyContacts,
          and(
            eq(partyContacts.partyContactId, portalMemberships.partyContactId),
            eq(partyContacts.organizationId, portalMemberships.organizationId),
            isNull(partyContacts.deletedAt),
          ),
        )
        .where(conditions)
        .orderBy(desc(portalMemberships.createdAt), desc(portalMemberships.portalMembershipId))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(portalMemberships).where(conditions),
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

  async getMembership(organizationId: string, portalMembershipId: string) {
    return this.loadMembership(organizationId, portalMembershipId);
  }

  async createMembership(organizationId: string, userId: string, input: CreateMembershipInput) {
    const [contact] = await this.db
      .select({ partyContactId: partyContacts.partyContactId })
      .from(partyContacts)
      .where(
        and(
          eq(partyContacts.partyContactId, input.partyContactId),
          eq(partyContacts.organizationId, organizationId),
          isNull(partyContacts.deletedAt),
        ),
      )
      .limit(1);
    if (!contact) {
      throw new NotFoundException("Party contact not found in this organization");
    }

    const [row] = await this.db
      .insert(portalMemberships)
      .values({
        organizationId,
        partyContactId: input.partyContactId,
        userMembershipId: input.userMembershipId ?? null,
        status: "PENDING",
      })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) {
          throw new ConflictException("Contact already has portal access in this organization.");
        }
        throw err;
      });
    if (!row) throw new NotFoundException("Failed to create portal membership");
    this.audit.log({
      action: "portal_access.membership.created",
      userId,
      orgId: organizationId,
      resourceType: "portal_membership",
      resourceId: row.portalMembershipId,
      metadata: { portalMembershipId: row.portalMembershipId, partyContactId: row.partyContactId },
    });
    return row;
  }

  async setMembershipStatus(
    organizationId: string,
    userId: string,
    portalMembershipId: string,
    input: UpdateMembershipStatusInput,
  ) {
    await this.loadMembership(organizationId, portalMembershipId);

    const patch: PgUpdateSetSource<typeof portalMemberships> = {
      status: input.status,
    };

    if (input.status === "SUSPENDED" || input.status === "REVOKED") {
      patch.sessionEpoch = sql`${portalMemberships.sessionEpoch} + 1`;
    }

    const [updated] = await this.db
      .update(portalMemberships)
      .set(patch)
      .where(
        and(
          eq(portalMemberships.portalMembershipId, portalMembershipId),
          eq(portalMemberships.organizationId, organizationId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Portal membership not found");
    this.audit.log({
      action: "portal_access.membership.status_changed",
      userId,
      orgId: organizationId,
      resourceType: "portal_membership",
      resourceId: portalMembershipId,
      metadata: { portalMembershipId, status: input.status },
    });
    return updated;
  }

  async listGrants(organizationId: string, query: ListGrantsQuery) {
    return listGrants(this.grantDeps, organizationId, query);
  }

  async getGrant(organizationId: string, projectClientGrantId: string) {
    return loadGrant(this.grantDeps, organizationId, projectClientGrantId);
  }

  async createGrant(organizationId: string, userId: string, input: CreateGrantInput) {
    return createGrant(this.grantDeps, organizationId, userId, input);
  }

  async updateGrant(
    organizationId: string,
    userId: string,
    projectClientGrantId: string,
    input: UpdateGrantInput,
  ) {
    return updateGrant(this.grantDeps, organizationId, userId, projectClientGrantId, input);
  }

  async revokeGrant(organizationId: string, userId: string, projectClientGrantId: string) {
    return revokeGrant(this.grantDeps, organizationId, userId, projectClientGrantId);
  }
}
