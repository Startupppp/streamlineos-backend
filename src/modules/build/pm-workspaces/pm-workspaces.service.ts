import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  pmWorkspaces,
  pmWorkspaceMemberships,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetAfter } from "../../../common/pagination/keyset";
import type {
  CreateWorkspaceInput,
  ListWorkspacesQuery,
  UpdateWorkspaceInput,
} from "./dto/pm-workspaces.schemas";
import { isUniqueViolation } from "../../../common/db/postgres-error";

type MembershipRow = typeof pmWorkspaceMemberships.$inferSelect;

type WorkspaceRow = typeof pmWorkspaces.$inferSelect;
type WorkspacePatch = Partial<typeof pmWorkspaces.$inferInsert>;

@Injectable()
export class PmWorkspacesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async loadWorkspace(
    orgId: string,
    pmWorkspaceId: string,
  ): Promise<WorkspaceRow> {
    const [row] = await this.db
      .select()
      .from(pmWorkspaces)
      .where(
        and(
          eq(pmWorkspaces.pmWorkspaceId, pmWorkspaceId),
          eq(pmWorkspaces.orgId, orgId),
          isNull(pmWorkspaces.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("PM workspace not found");
    return row;
  }

  async listWorkspaces(orgId: string, query: ListWorkspacesQuery) {
    const { cursor, limit, status } = query;
    const pos = decodeCursor(cursor);
    const conds = [
      eq(pmWorkspaces.orgId, orgId),
      isNull(pmWorkspaces.deletedAt),
      status ? eq(pmWorkspaces.status, status) : undefined,
    ];
    if (pos) conds.push(keysetAfter(pmWorkspaces.createdAt, pmWorkspaces.slug, pos));

    const rows = await this.db
      .select()
      .from(pmWorkspaces)
      .where(and(...conds))
      .orderBy(asc(pmWorkspaces.createdAt), asc(pmWorkspaces.slug))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (r) => ({
      sortValue: (r.createdAt ?? new Date(0)).toISOString(),
      id: r.slug,
    }));
  }

  async getWorkspace(orgId: string, pmWorkspaceId: string) {
    return this.loadWorkspace(orgId, pmWorkspaceId);
  }

  async createWorkspace(
    orgId: string,
    userId: string,
    input: CreateWorkspaceInput,
  ) {
    const [row] = await this.db
      .insert(pmWorkspaces)
      .values({
        orgId,
        name: input.name,
        slug: input.slug,
        isDefault: false,
        status: "active",
      })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `A PM workspace with slug "${input.slug}" already exists in this organization.`,
          );
        }
        throw err;
      });
    if (!row) throw new NotFoundException("Failed to create PM workspace");
    this.audit.log({
      action: "pm_workspace.created",
      userId,
      orgId,
      resourceType: "pm_workspace",
      resourceId: row.pmWorkspaceId,
      metadata: { pmWorkspaceId: row.pmWorkspaceId, slug: row.slug },
    });
    return row;
  }

  /** Idempotently ensure the org's single default PM Workspace exists (called when PM is enabled). */
  async ensureDefaultWorkspace(orgId: string): Promise<WorkspaceRow> {
    const [existing] = await this.db
      .select()
      .from(pmWorkspaces)
      .where(
        and(
          eq(pmWorkspaces.orgId, orgId),
          eq(pmWorkspaces.isDefault, true),
          isNull(pmWorkspaces.deletedAt),
        ),
      )
      .limit(1);
    if (existing) return existing;
    try {
      const [row] = await this.db
        .insert(pmWorkspaces)
        .values({
          orgId,
          name: "Default Workspace",
          slug: "default",
          isDefault: true,
          status: "active",
        })
        .returning();
      if (!row)
        throw new NotFoundException("Failed to provision default PM workspace");
      return row;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        const [row] = await this.db
          .select()
          .from(pmWorkspaces)
          .where(
            and(
              eq(pmWorkspaces.orgId, orgId),
              eq(pmWorkspaces.isDefault, true),
            ),
          )
          .limit(1);
        if (row) return row;
      }
      throw err;
    }
  }

  /**
   * Resolve the default PM workspace ID for an org, provisioning it if absent.
   * Call this from Build creation services when the caller does not supply a
   * pmWorkspaceId, so the NOT NULL constraint introduced by migration 0333
   * is always satisfied.
   *
   * CALL SITES OUTSIDE THIS MODULE (not modifiable here — report to maintainer):
   *   src/modules/build/projects-provision.service.ts  createProject / createFromDeal
   *     → resolve pmWorkspaceId before the tx.insert(projects) and pass it in.
   *   src/modules/build-managed-products/managed-products.service.ts  createManagedProduct
   *     → same pattern.
   *   src/modules/build/projects-workspace-members.service.ts  addMember
   *     → supply pmWorkspaceId from the project's own pmWorkspaceId.
   */
  async resolveDefaultWorkspaceId(orgId: string): Promise<string> {
    const workspace = await this.ensureDefaultWorkspace(orgId);
    return workspace.pmWorkspaceId;
  }

  /**
   * Transactional idempotent provisioning of the default PM workspace + owner
   * membership. Call this from the module-enable path when the Build module is
   * toggled on for an org.
   *
   * CALL SITE NEEDED (outside this module's scope):
   *   src/modules/organization/organization-settings.service.ts  updateSettings
   *   After the `enabled_modules` update, when 'BUILD' enters the new set:
   *     await this.pmWorkspacesService.provisionOnModuleEnable(orgId);
   *
   * The method is safe to call even if provisioning already occurred — both
   * the workspace insert and the membership insert are no-ops when the rows
   * already exist.
   */
  async provisionOnModuleEnable(
    orgId: string,
  ): Promise<{ workspace: WorkspaceRow; membershipId: string | null }> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(pmWorkspaces)
        .where(
          and(
            eq(pmWorkspaces.orgId, orgId),
            eq(pmWorkspaces.isDefault, true),
            isNull(pmWorkspaces.deletedAt),
          ),
        )
        .limit(1);

      let workspace: WorkspaceRow;
      if (existing) {
        workspace = existing;
      } else {
        const inserted = await tx
          .insert(pmWorkspaces)
          .values({
            orgId,
            name: "Default Workspace",
            slug: "default",
            isDefault: true,
            status: "active",
          })
          .onConflictDoNothing()
          .returning();
        const row = inserted[0];
        if (!row) {
          const [recovered] = await tx
            .select()
            .from(pmWorkspaces)
            .where(
              and(
                eq(pmWorkspaces.orgId, orgId),
                eq(pmWorkspaces.isDefault, true),
              ),
            )
            .limit(1);
          if (!recovered)
            throw new NotFoundException(
              "Failed to provision default PM workspace",
            );
          workspace = recovered;
        } else {
          workspace = row;
        }
      }

      const [ownerMember] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.isOwner, true),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .limit(1);

      if (!ownerMember) {
        return { workspace, membershipId: null };
      }

      const membershipInserted = await tx
        .insert(pmWorkspaceMemberships)
        .values({
          orgId,
          pmWorkspaceId: workspace.pmWorkspaceId,
          organizationMembershipId: ownerMember.id,
          role: "admin",
        })
        .onConflictDoNothing()
        .returning();

      const membership: MembershipRow | undefined = membershipInserted[0];
      return {
        workspace,
        membershipId: membership?.pmWorkspaceMembershipId ?? null,
      };
    });
  }

  async updateWorkspace(
    orgId: string,
    userId: string,
    pmWorkspaceId: string,
    input: UpdateWorkspaceInput,
  ) {
    await this.loadWorkspace(orgId, pmWorkspaceId);
    const patch: WorkspacePatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.status !== undefined) patch.status = input.status;
    const [updated] = await this.db
      .update(pmWorkspaces)
      .set(patch)
      .where(
        and(
          eq(pmWorkspaces.pmWorkspaceId, pmWorkspaceId),
          eq(pmWorkspaces.orgId, orgId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("PM workspace not found");
    this.audit.log({
      action: "pm_workspace.updated",
      userId,
      orgId,
      resourceType: "pm_workspace",
      resourceId: pmWorkspaceId,
      metadata: { pmWorkspaceId },
    });
    return updated;
  }

  async deleteWorkspace(orgId: string, userId: string, pmWorkspaceId: string) {
    const workspace = await this.loadWorkspace(orgId, pmWorkspaceId);
    if (workspace.isDefault) {
      throw new ForbiddenException(
        "The default PM workspace cannot be deleted",
      );
    }
    await this.db
      .update(pmWorkspaces)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(pmWorkspaces.pmWorkspaceId, pmWorkspaceId),
          eq(pmWorkspaces.orgId, orgId),
        ),
      );
    this.audit.log({
      action: "pm_workspace.deleted",
      userId,
      orgId,
      resourceType: "pm_workspace",
      resourceId: pmWorkspaceId,
      metadata: { pmWorkspaceId },
    });
  }

}
