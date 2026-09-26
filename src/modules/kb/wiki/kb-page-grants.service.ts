import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  kbPageGrants,
  kbPages,
  organizationMembers,
  users,
} from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { AuditService } from "../../../common/audit/audit.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import {
  buildCursorPage,
  decodeCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";
import type {
  CreateKbPageGrantInput,
  KbPageGrantsListQuery,
} from "./dto/kb-page-grants.schemas";
import type { KbPageGrantItem } from "./dto/kb-page-grants-response.schemas";
import {
  keysetBeforeMicros,
  microsecondCursorValue,
} from "../../../common/pagination/keyset";

const GRANT_COLUMNS = {
  id: kbPageGrants.id,
  pageId: kbPageGrants.pageId,
  membershipId: kbPageGrants.membershipId,
  role: kbPageGrants.role,
  access: kbPageGrants.access,
  grantedByMembershipId: kbPageGrants.grantedByMembershipId,
  createdAt: kbPageGrants.createdAt,
  revokedAt: kbPageGrants.revokedAt,
};

@Injectable()
export class KbPageGrantsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: KnowledgeAuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: CurrentUserContext,
    pageId: number,
    query: KbPageGrantsListQuery,
  ): Promise<CursorPage<KbPageGrantItem>> {
    await this.auth.assertPageAccess(user, pageId, "manage");

    const position = decodeCursor(query.cursor);
    const after = position
      ? keysetBeforeMicros(kbPageGrants.createdAt, kbPageGrants.id, {
          sortValue: String(position.sortValue),
          id: Number(position.id),
        })
      : undefined;

    const rows = await this.db
      .select({
        ...GRANT_COLUMNS,
        createdAtMicros: microsecondCursorValue(kbPageGrants.createdAt),
        granteeName: users.name,
        granteeEmail: users.email,
        granteeImage: users.image,
      })
      .from(kbPageGrants)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, kbPageGrants.orgId),
          eq(organizationMembers.id, kbPageGrants.membershipId),
        ),
      )
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(kbPageGrants.orgId, user.orgId),
          eq(kbPageGrants.pageId, pageId),
          isNull(kbPageGrants.revokedAt),
          after,
        ),
      )
      .orderBy(desc(kbPageGrants.createdAt), desc(kbPageGrants.id))
      .limit(query.limit + 1);

    const cursorValues = new Map(rows.map((r) => [r.id, r.createdAtMicros]));

    const items: KbPageGrantItem[] = rows.map((r) => ({
      id: r.id,
      pageId: r.pageId,
      membershipId: r.membershipId,
      role: r.role,
      access: r.access,
      grantedByMembershipId: r.grantedByMembershipId,
      createdAt: r.createdAt,
      revokedAt: r.revokedAt,
      granteeName: r.granteeName,
      granteeEmail: r.granteeEmail,
      granteeImage: r.granteeImage,
    }));

    return buildCursorPage(items, query.limit, (row) => ({
      sortValue: cursorValues.get(row.id) ?? row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async create(
    user: CurrentUserContext,
    pageId: number,
    input: CreateKbPageGrantInput,
  ): Promise<KbPageGrantItem> {
    await this.auth.assertPageAccess(user, pageId, "manage");

    const actorMembership = actingMembershipId(user.principal);

    if (
      input.membershipId !== undefined &&
      actorMembership !== null &&
      input.membershipId === actorMembership
    ) {
      throw new BadRequestException("Cannot grant access to yourself");
    }

    if (input.membershipId !== undefined) {
      const [member] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.id, input.membershipId),
            eq(organizationMembers.orgId, user.orgId),
          ),
        )
        .limit(1);
      if (!member) throw new NotFoundException("Membership not found");
    }

    const existing = await this.findLiveGrant(
      user.orgId,
      pageId,
      input.membershipId,
      input.role,
    );

    let grant: KbPageGrantItem;
    try {
      grant = await this.db.transaction(async (tx) => {
        let row: Omit<
          KbPageGrantItem,
          "granteeName" | "granteeEmail" | "granteeImage"
        >;

        if (existing) {
          const [updated] = await tx
            .update(kbPageGrants)
            .set({ access: input.access })
            .where(
              and(
                eq(kbPageGrants.id, existing.id),
                eq(kbPageGrants.orgId, user.orgId),
              ),
            )
            .returning(GRANT_COLUMNS);
          if (!updated) throw new NotFoundException("Grant not found");
          row = updated;
        } else {
          const [inserted] = await tx
            .insert(kbPageGrants)
            .values({
              orgId: user.orgId,
              pageId,
              membershipId: input.membershipId ?? null,
              role: input.role ?? null,
              access: input.access,
              grantedByMembershipId: actorMembership,
            })
            .returning(GRANT_COLUMNS);
          if (!inserted) throw new NotFoundException("Insert failed");
          row = inserted;
        }

        await tx
          .update(kbPages)
          .set({
            aclRevision: sql`acl_revision + 1`,
            aclRevisionChangedAt: new Date(),
          })
          .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, user.orgId)));

        return {
          ...row,
          granteeName: null,
          granteeEmail: null,
          granteeImage: null,
        };
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException("Grant already exists");
      throw err;
    }

    this.audit.log({
      action: "kb.page_grant.created",
      userId: user.userId,
      orgId: user.orgId,
      resourceType: "kb_page_grant",
      resourceId: String(grant.id),
      metadata: { pageId, access: input.access },
    });

    const deferred = registerAfterCommit(async () => {
      await this.auth.invalidateSpaceScope(user.orgId);
      await this.syncChunkAclRevision(user.orgId, pageId);
    });
    if (!deferred) {
      await this.auth.invalidateSpaceScope(user.orgId);
      await this.syncChunkAclRevision(user.orgId, pageId);
    }

    return grant;
  }

  async revoke(
    user: CurrentUserContext,
    pageId: number,
    grantId: number,
  ): Promise<void> {
    await this.auth.assertPageAccess(user, pageId, "manage");

    await this.db.transaction(async (tx) => {
      const [revoked] = await tx
        .update(kbPageGrants)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(kbPageGrants.id, grantId),
            eq(kbPageGrants.orgId, user.orgId),
            eq(kbPageGrants.pageId, pageId),
            isNull(kbPageGrants.revokedAt),
          ),
        )
        .returning({ revokedAt: kbPageGrants.revokedAt });

      if (!revoked)
        throw new NotFoundException("Grant not found or already revoked");

      await tx
        .update(kbPages)
        .set({
          aclRevision: sql`acl_revision + 1`,
          aclRevisionChangedAt: new Date(),
        })
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, user.orgId)));
    });

    this.audit.log({
      action: "kb.page_grant.revoked",
      userId: user.userId,
      orgId: user.orgId,
      resourceType: "kb_page_grant",
      resourceId: String(grantId),
      metadata: { pageId },
    });

    const deferred = registerAfterCommit(async () => {
      await this.auth.invalidateSpaceScope(user.orgId);
      await this.syncChunkAclRevision(user.orgId, pageId);
    });
    if (!deferred) {
      await this.auth.invalidateSpaceScope(user.orgId);
      await this.syncChunkAclRevision(user.orgId, pageId);
    }
  }

  private async syncChunkAclRevision(
    orgId: string,
    pageId: number,
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE kb_article_chunks c
      SET acl_revision = p.acl_revision,
          acl_synced_at = NOW()
      FROM kb_pages p
      WHERE c.page_id = p.id
        AND c.org_id = ${orgId}
        AND c.page_id = ${pageId}
        AND c.acl_revision != p.acl_revision
    `);
  }

  private async findLiveGrant(
    orgId: string,
    pageId: number,
    membershipId: number | undefined,
    role: string | undefined,
  ): Promise<{ id: number } | undefined> {
    if (membershipId !== undefined) {
      const [row] = await this.db
        .select({ id: kbPageGrants.id })
        .from(kbPageGrants)
        .where(
          and(
            eq(kbPageGrants.orgId, orgId),
            eq(kbPageGrants.pageId, pageId),
            eq(kbPageGrants.membershipId, membershipId),
            isNull(kbPageGrants.revokedAt),
          ),
        )
        .limit(1);
      return row;
    }
    if (role !== undefined) {
      const [row] = await this.db
        .select({ id: kbPageGrants.id })
        .from(kbPageGrants)
        .where(
          and(
            eq(kbPageGrants.orgId, orgId),
            eq(kbPageGrants.pageId, pageId),
            eq(kbPageGrants.role, role),
            isNull(kbPageGrants.revokedAt),
          ),
        )
        .limit(1);
      return row;
    }
    return undefined;
  }
}
