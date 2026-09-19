import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import {
  managedProducts,
  pmWorkspaces,
  projectMembers,
  projectTeamAssignments,
  projectTeamMembers,
  projects,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { ScopeDirectoryRef } from "./dto/scope-directory.schemas";

type ScopeKeyType = "workspace" | "product" | "project";

interface ParsedScopeKey {
  key: string;
  type: ScopeKeyType;
  rawId: string;
}

function parseScopeKey(key: string): ParsedScopeKey | undefined {
  const sep = key.indexOf(":");
  if (sep === -1) return undefined;
  const prefix = key.slice(0, sep);
  const rawId = key.slice(sep + 1);
  if (!rawId) return undefined;
  if (prefix === "workspace" || prefix === "product" || prefix === "project")
    return { key, type: prefix, rawId };
  return undefined;
}

@Injectable()
export class ScopeDirectoryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async resolveScopeDirectory(
    orgId: string,
    userId: string,
    membershipId: number | null,
    keys: string[],
  ): Promise<ScopeDirectoryRef[]> {
    const parsed = keys
      .map(parseScopeKey)
      .filter((e): e is ParsedScopeKey => e !== undefined);

    const workspaceEntries = parsed.filter((e) => e.type === "workspace");
    const productEntries = parsed.filter((e) => e.type === "product");
    const projectEntries = parsed.filter((e) => e.type === "project");
    const requestedProjectIds = projectEntries.map((e) => Number(e.rawId));

    const hasProjectKeys = projectEntries.length > 0;
    const perms = hasProjectKeys
      ? await this.access.resolveUserPermissions(orgId, userId)
      : new Map<string, string>();
    const projectAccessIsUnrestricted = perms.get("build:manage") === "all";

    let accessibleProjectIds: number[] | null = null;
    if (hasProjectKeys && !projectAccessIsUnrestricted) {
      if (membershipId === null) {
        accessibleProjectIds = [];
      } else {
        const [directRows, teamRows] = await Promise.all([
          this.db
            .select({ projectId: projectMembers.projectId })
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.orgId, orgId),
                inArray(projectMembers.projectId, requestedProjectIds),
                eq(projectMembers.membershipId, membershipId),
              ),
            ),
          this.db
            .select({ projectId: projectTeamAssignments.projectId })
            .from(projectTeamAssignments)
            .innerJoin(
              projectTeamMembers,
              and(
                eq(projectTeamMembers.orgId, projectTeamAssignments.orgId),
                eq(projectTeamMembers.teamId, projectTeamAssignments.teamId),
                eq(projectTeamMembers.membershipId, membershipId),
              ),
            )
            .where(
              and(
                eq(projectTeamAssignments.orgId, orgId),
                inArray(projectTeamAssignments.projectId, requestedProjectIds),
              ),
            ),
        ]);
        const idSet = new Set<number>([
          ...directRows.map((r) => r.projectId),
          ...teamRows.map((r) => r.projectId),
        ]);
        accessibleProjectIds = [...idSet];
      }
    }

    const buildProjectWhere = (): SQL<unknown> | null => {
      if (!hasProjectKeys) return null;
      const base: SQL<unknown>[] = [
        eq(projects.orgId, orgId),
        inArray(projects.id, requestedProjectIds),
        isNull(projects.deletedAt),
      ];
      if (accessibleProjectIds !== null) {
        const hasDirectAccess = accessibleProjectIds.length > 0;
        const hasManagerAccess = membershipId !== null;
        if (!hasDirectAccess && !hasManagerAccess) return null;
        const memberFilter = hasDirectAccess && hasManagerAccess && membershipId !== null
          ? or(inArray(projects.id, accessibleProjectIds), eq(projects.managerMembershipId, membershipId))
          : hasDirectAccess
            ? inArray(projects.id, accessibleProjectIds)
            : membershipId !== null
              ? eq(projects.managerMembershipId, membershipId)
              : null;
        if (memberFilter) base.push(memberFilter);
      }
      return and(...base) ?? null;
    };

    const projectWhere = buildProjectWhere();

    const [workspaceRows, productRows, projectRows] = await Promise.all([
      workspaceEntries.length
        ? this.db
            .select({
              pmWorkspaceId: pmWorkspaces.pmWorkspaceId,
              name: pmWorkspaces.name,
              status: pmWorkspaces.status,
            })
            .from(pmWorkspaces)
            .where(
              and(
                eq(pmWorkspaces.orgId, orgId),
                inArray(pmWorkspaces.pmWorkspaceId, workspaceEntries.map((e) => e.rawId)),
                isNull(pmWorkspaces.deletedAt),
              ),
            )
        : Promise.resolve([]),
      productEntries.length
        ? this.db
            .select({
              id: managedProducts.id,
              name: managedProducts.name,
              key: managedProducts.key,
              status: managedProducts.status,
              pmWorkspaceId: managedProducts.pmWorkspaceId,
            })
            .from(managedProducts)
            .where(
              and(
                eq(managedProducts.orgId, orgId),
                inArray(managedProducts.id, productEntries.map((e) => Number(e.rawId))),
                isNull(managedProducts.deletedAt),
              ),
            )
        : Promise.resolve([]),
      projectWhere !== null
        ? this.db
            .select({
              id: projects.id,
              name: projects.name,
              key: projects.key,
              status: projects.status,
              managedProductId: projects.managedProductId,
              pmWorkspaceId: projects.pmWorkspaceId,
              clientMembershipId: projects.clientMembershipId,
            })
            .from(projects)
            .where(projectWhere)
        : Promise.resolve([]),
    ]);

    const workspaceById = new Map(workspaceRows.map((r) => [r.pmWorkspaceId, r]));
    const productById = new Map(productRows.map((r) => [r.id, r]));
    const projectById = new Map(projectRows.map((r) => [r.id, r]));

    const missingProductIds = [
      ...new Set(
        projectRows
          .map((r) => r.managedProductId)
          .filter((id): id is number => id !== null && !productById.has(id)),
      ),
    ];
    const ancestorProductRows = missingProductIds.length
      ? await this.db
          .select({
            id: managedProducts.id,
            name: managedProducts.name,
            key: managedProducts.key,
            status: managedProducts.status,
            pmWorkspaceId: managedProducts.pmWorkspaceId,
          })
          .from(managedProducts)
          .where(
            and(
              eq(managedProducts.orgId, orgId),
              inArray(managedProducts.id, missingProductIds),
              isNull(managedProducts.deletedAt),
            ),
          )
      : [];
    for (const r of ancestorProductRows) productById.set(r.id, r);

    const allProductRowsForPaths = [...productRows, ...ancestorProductRows];
    const missingWorkspaceIds = [
      ...new Set(
        [
          ...allProductRowsForPaths.map((r) => r.pmWorkspaceId),
          ...projectRows.map((r) => r.pmWorkspaceId),
        ].filter((id) => !workspaceById.has(id)),
      ),
    ];
    const ancestorWorkspaceRows = missingWorkspaceIds.length
      ? await this.db
          .select({
            pmWorkspaceId: pmWorkspaces.pmWorkspaceId,
            name: pmWorkspaces.name,
            status: pmWorkspaces.status,
          })
          .from(pmWorkspaces)
          .where(
            and(
              eq(pmWorkspaces.orgId, orgId),
              inArray(pmWorkspaces.pmWorkspaceId, missingWorkspaceIds),
              isNull(pmWorkspaces.deletedAt),
            ),
          )
      : [];
    for (const r of ancestorWorkspaceRows) workspaceById.set(r.pmWorkspaceId, r);

    const refs: ScopeDirectoryRef[] = [];
    for (const entry of parsed) {
      if (entry.type === "workspace") {
        const row = workspaceById.get(entry.rawId);
        if (!row) continue;
        refs.push({
          key: entry.key,
          type: "workspace",
          id: row.pmWorkspaceId,
          name: row.name,
          parentKey: null,
          projectKey: null,
          isArchived: row.status === "archived",
          parentPath: null,
          clientPortalEnabled: null,
        });
        continue;
      }

      if (entry.type === "product") {
        const row = productById.get(Number(entry.rawId));
        if (!row) continue;
        const ws = workspaceById.get(row.pmWorkspaceId);
        refs.push({
          key: entry.key,
          type: "product",
          id: String(row.id),
          name: row.name,
          parentKey: `workspace:${row.pmWorkspaceId}`,
          projectKey: row.key,
          isArchived: row.status === "archived",
          parentPath: ws?.name ?? null,
          clientPortalEnabled: null,
        });
        continue;
      }

      const row = projectById.get(Number(entry.rawId));
      if (!row) continue;
      const ws = workspaceById.get(row.pmWorkspaceId);
      const prod =
        row.managedProductId !== null ? productById.get(row.managedProductId) : null;
      let parentPath: string | null = null;
      if (ws && prod) parentPath = `${ws.name} > ${prod.name}`;
      else if (ws) parentPath = ws.name;
      else if (prod) parentPath = prod.name;
      refs.push({
        key: entry.key,
        type: "project",
        id: String(row.id),
        name: row.name,
        parentKey: row.managedProductId !== null ? `product:${row.managedProductId}` : null,
        projectKey: row.key,
        isArchived: row.status === "ARCHIVED",
        parentPath,
        clientPortalEnabled: row.clientMembershipId !== null,
      });
    }

    return refs;
  }
}
