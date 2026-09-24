import { Inject, Injectable } from "@nestjs/common";
import { and, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  managedProductMemberships,
  managedProducts,
  projectMembers,
  projectTeamAssignments,
  projectTeamMembers,
  projects,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { encodeTupleCursor, decodeTupleCursor } from "../../../common/pagination/cursor";
import type { ScopeDirectoryRef } from "./dto/scope-directory.schemas";

type ScopeKeyType = "product" | "project";

interface ParsedScopeKey {
  key: string;
  type: ScopeKeyType;
  rawId: string;
}

type ProductRow = Pick<typeof managedProducts.$inferSelect, "id" | "name" | "key" | "status">;
type ProjectRow = Pick<typeof projects.$inferSelect, "id" | "name" | "key" | "status" | "managedProductId" | "clientMembershipId">;

type SearchCursorTypeIndex = 0 | 1;
type SearchCursorRank = 0 | 1;

interface SearchCursor {
  typeIndex: SearchCursorTypeIndex;
  rank: SearchCursorRank;
  name: string;
  id: string;
}

function parseScopeKey(key: string): ParsedScopeKey | undefined {
  const sep = key.indexOf(":");
  if (sep === -1) return undefined;
  const prefix = key.slice(0, sep);
  const rawId = key.slice(sep + 1);
  if (!rawId) return undefined;
  if (prefix === "product" || prefix === "project")
    return { key, type: prefix, rawId };
  return undefined;
}

function decodeSearchCursor(cursor: string | undefined): SearchCursor | null {
  if (!cursor) return null;
  const parts = decodeTupleCursor(cursor, 4);
  if (!parts) return null;
  const typeStr = parts[0] ?? "";
  const rankStr = parts[1] ?? "";
  const name = parts[2] ?? "";
  const id = parts[3] ?? "";
  const typeIndex = Number(typeStr);
  const rank = Number(rankStr);
  if (!Number.isInteger(typeIndex) || typeIndex < 0 || typeIndex > 1) return null;
  if (rank !== 0 && rank !== 1) return null;
  if (name.length === 0 || id.length === 0) return null;
  if (!/^[1-9][0-9]*$/.test(id)) return null;
  return {
    typeIndex: typeIndex as SearchCursorTypeIndex,
    rank: rank as SearchCursorRank,
    name,
    id,
  };
}

@Injectable()
export class ScopeDirectoryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  private buildScopeRefs(
    entries: ReadonlyArray<ParsedScopeKey>,
    productById: ReadonlyMap<number, ProductRow>,
    projectById: ReadonlyMap<number, ProjectRow>,
  ): ScopeDirectoryRef[] {
    const refs: ScopeDirectoryRef[] = [];
    for (const entry of entries) {
      if (entry.type === "product") {
        const row = productById.get(Number(entry.rawId));
        if (!row) continue;
        refs.push({
          key: entry.key,
          type: "product",
          id: String(row.id),
          name: row.name,
          parentKey: null,
          projectKey: row.key,
          isArchived: row.status === "archived",
          parentPath: null,
          clientPortalEnabled: null,
        });
        continue;
      }
      const row = projectById.get(Number(entry.rawId));
      if (!row) continue;
      const prod = row.managedProductId !== null ? productById.get(row.managedProductId) : null;
      const parentPath = prod ? prod.name : null;
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

  private async fetchMissingAncestors(
    orgId: string,
    projectRows: ReadonlyArray<{ managedProductId: number | null }>,
    productById: Map<number, ProductRow>,
  ): Promise<void> {
    const missingProductIds = [
      ...new Set(
        projectRows
          .map((r) => r.managedProductId)
          .filter((id): id is number => id !== null && !productById.has(id)),
      ),
    ];
    if (missingProductIds.length) {
      const rows = await this.db
        .select({
          id: managedProducts.id,
          name: managedProducts.name,
          key: managedProducts.key,
          status: managedProducts.status,
        })
        .from(managedProducts)
        .where(
          and(
            eq(managedProducts.orgId, orgId),
            inArray(managedProducts.id, missingProductIds),
            isNull(managedProducts.deletedAt),
          ),
        );
      for (const r of rows) productById.set(r.id, r);
    }
  }

  async resolveScopeDirectory(
    orgId: string,
    userId: string,
    membershipId: number | null,
    keys: string[],
  ): Promise<ScopeDirectoryRef[]> {
    const parsed = keys
      .map(parseScopeKey)
      .filter((e): e is ParsedScopeKey => e !== undefined);

    const productEntries = parsed.filter((e) => e.type === "product");
    const projectEntries = parsed.filter((e) => e.type === "project");
    const requestedProjectIds = projectEntries.map((e) => Number(e.rawId));

    const hasProductKeys = productEntries.length > 0;
    const hasProjectKeys = projectEntries.length > 0;

    const perms =
      hasProductKeys || hasProjectKeys
        ? await this.access.resolveUserPermissions(orgId, userId)
        : new Map<string, string>();
    const buildManageIsAll = perms.get("build:manage") === "all";

    let accessibleProjectIds: number[] | null = null;
    let accessibleProductIds: number[] | null = null;

    if (!buildManageIsAll && (hasProjectKeys || hasProductKeys)) {
      const projectTask: Promise<void> = hasProjectKeys
        ? (async () => {
            if (membershipId === null) {
              accessibleProjectIds = [];
              return;
            }
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
          })()
        : Promise.resolve();

      const productTask: Promise<void> = hasProductKeys
        ? (async () => {
            if (membershipId === null) {
              accessibleProductIds = [];
              return;
            }
            const prodRows = await this.db
              .select({ managedProductId: managedProductMemberships.managedProductId })
              .from(managedProductMemberships)
              .where(
                and(
                  eq(managedProductMemberships.orgId, orgId),
                  inArray(
                    managedProductMemberships.managedProductId,
                    productEntries.map((e) => Number(e.rawId)),
                  ),
                  eq(managedProductMemberships.organizationMembershipId, membershipId),
                ),
              );
            accessibleProductIds = prodRows.map((r) => r.managedProductId);
          })()
        : Promise.resolve();

      await Promise.all([projectTask, productTask]);
    }

    const productIdsToFetch: number[] =
      accessibleProductIds !== null
        ? accessibleProductIds
        : productEntries.map((e) => Number(e.rawId));

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
        const memberFilter =
          hasDirectAccess && hasManagerAccess && membershipId !== null
            ? or(
                inArray(projects.id, accessibleProjectIds),
                eq(projects.managerMembershipId, membershipId),
              )
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

    const [productRows, projectRows] = await Promise.all([
      productIdsToFetch.length > 0
        ? this.db
            .select({
              id: managedProducts.id,
              name: managedProducts.name,
              key: managedProducts.key,
              status: managedProducts.status,
            })
            .from(managedProducts)
            .where(
              and(
                eq(managedProducts.orgId, orgId),
                inArray(managedProducts.id, productIdsToFetch),
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
              clientMembershipId: projects.clientMembershipId,
            })
            .from(projects)
            .where(projectWhere)
        : Promise.resolve([]),
    ]);

    const productById = new Map(productRows.map((r) => [r.id, r]));
    const projectById = new Map(projectRows.map((r) => [r.id, r]));

    await this.fetchMissingAncestors(orgId, projectRows, productById);

    return this.buildScopeRefs(parsed, productById, projectById);
  }

  async searchScopeDirectory(
    orgId: string,
    userId: string,
    membershipId: number | null,
    q: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<{ data: ScopeDirectoryRef[]; nextCursor: string | null }> {
    const perms = await this.access.resolveUserPermissions(orgId, userId);
    const buildManageIsAll = perms.get("build:manage") === "all";

    if (!buildManageIsAll && membershipId === null)
      return { data: [], nextCursor: null };

    const pos = decodeSearchCursor(cursor);
    const escapedQ = q.replace(/[%_\\]/g, (c) => `\\${c}`);

    let accessibleProdIds: number[] | null = null;
    let accessibleProjIds: number[] | null = null;

    if (!buildManageIsAll && membershipId !== null) {
      const [prodRows, directRows, teamRows] = await Promise.all([
        this.db
          .select({ managedProductId: managedProductMemberships.managedProductId })
          .from(managedProductMemberships)
          .where(
            and(
              eq(managedProductMemberships.orgId, orgId),
              eq(managedProductMemberships.organizationMembershipId, membershipId),
            ),
          ),
        this.db
          .select({ projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.orgId, orgId),
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
          .where(eq(projectTeamAssignments.orgId, orgId)),
      ]);
      accessibleProdIds = prodRows.map((r) => r.managedProductId);
      const projSet = new Set([
        ...directRows.map((r) => r.projectId),
        ...teamRows.map((r) => r.projectId),
      ]);
      accessibleProjIds = [...projSet];
    }

    const prodCursorCond =
      pos !== null && pos.typeIndex === 0
        ? sql`(CASE WHEN ${managedProducts.name} = ${q} THEN 0 ELSE 1 END, ${managedProducts.name}, ${managedProducts.id}) > (${pos.rank}, ${pos.name}, ${Number(pos.id)})`
        : undefined;

    const prodResults: ProductRow[] = await (async () => {
      if (pos !== null && pos.typeIndex > 0) return [];
      if (accessibleProdIds !== null && accessibleProdIds.length === 0) return [];
      return this.db
        .select({
          id: managedProducts.id,
          name: managedProducts.name,
          key: managedProducts.key,
          status: managedProducts.status,
        })
        .from(managedProducts)
        .where(
          and(
            eq(managedProducts.orgId, orgId),
            isNull(managedProducts.deletedAt),
            or(eq(managedProducts.name, q), ilike(managedProducts.name, `${escapedQ}%`)),
            accessibleProdIds !== null
              ? inArray(managedProducts.id, accessibleProdIds)
              : undefined,
            prodCursorCond,
          ),
        )
        .orderBy(
          sql`CASE WHEN ${managedProducts.name} = ${q} THEN 0 ELSE 1 END`,
          managedProducts.name,
          managedProducts.id,
        )
        .limit(limit + 1);
    })();

    const projCursorCond =
      pos !== null && pos.typeIndex === 1
        ? sql`(CASE WHEN ${projects.name} = ${q} THEN 0 ELSE 1 END, ${projects.name}, ${projects.id}) > (${pos.rank}, ${pos.name}, ${Number(pos.id)})`
        : undefined;

    const projResults: ProjectRow[] = await (async () => {
      if (accessibleProjIds !== null && accessibleProjIds.length === 0 && membershipId === null)
        return [];
      const authFilter =
        accessibleProjIds !== null && membershipId !== null
          ? or(
              accessibleProjIds.length > 0
                ? inArray(projects.id, accessibleProjIds)
                : undefined,
              eq(projects.managerMembershipId, membershipId),
            )
          : undefined;
      if (accessibleProjIds !== null && accessibleProjIds.length === 0 && authFilter === undefined)
        return [];
      return this.db
        .select({
          id: projects.id,
          name: projects.name,
          key: projects.key,
          status: projects.status,
          managedProductId: projects.managedProductId,
          clientMembershipId: projects.clientMembershipId,
        })
        .from(projects)
        .where(
          and(
            eq(projects.orgId, orgId),
            isNull(projects.deletedAt),
            or(eq(projects.name, q), ilike(projects.name, `${escapedQ}%`)),
            authFilter,
            projCursorCond,
          ),
        )
        .orderBy(
          sql`CASE WHEN ${projects.name} = ${q} THEN 0 ELSE 1 END`,
          projects.name,
          projects.id,
        )
        .limit(limit + 1);
    })();

    type MergedHit = {
      typeIndex: number;
      rank: number;
      name: string;
      id: string;
      entry: ParsedScopeKey;
    };

    const hits: MergedHit[] = [];
    for (const r of prodResults) {
      const rank = r.name === q ? 0 : 1;
      hits.push({ typeIndex: 0, rank, name: r.name, id: String(r.id), entry: { key: `product:${r.id}`, type: "product", rawId: String(r.id) } });
    }
    for (const r of projResults) {
      const rank = r.name === q ? 0 : 1;
      hits.push({ typeIndex: 1, rank, name: r.name, id: String(r.id), entry: { key: `project:${r.id}`, type: "project", rawId: String(r.id) } });
    }

    hits.sort((a, b) => {
      if (a.typeIndex !== b.typeIndex) return a.typeIndex - b.typeIndex;
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const hasMore = hits.length > limit;
    const pageHits = hasMore ? hits.slice(0, limit) : hits;

    const nextCursor: string | null =
      hasMore && pageHits.length > 0
        ? (() => {
            const last = pageHits[pageHits.length - 1];
            if (!last) return null;
            return encodeTupleCursor([
              String(last.typeIndex),
              String(last.rank),
              last.name,
              last.id,
            ]);
          })()
        : null;

    const productById = new Map<number, ProductRow>();
    const projectById = new Map<number, ProjectRow>();

    for (const r of prodResults.slice(0, limit + 1)) productById.set(r.id, r);
    for (const r of projResults.slice(0, limit + 1)) projectById.set(r.id, r);

    await this.fetchMissingAncestors(
      orgId,
      projResults.slice(0, limit + 1),
      productById,
    );

    const data = this.buildScopeRefs(
      pageHits.map((h) => h.entry),
      productById,
      projectById,
    );

    return { data, nextCursor };
  }
}
