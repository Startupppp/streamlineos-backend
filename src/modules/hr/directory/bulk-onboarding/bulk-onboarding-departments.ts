import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { orgUnits } from "../../../../db/schema";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import {
  nextDepartmentCode,
  toDepartmentCode,
} from "../../../organization/hierarchy/lib/department-code";
import { HR_SCAN_MAX_PAGES, HR_SCAN_PAGE } from "../../hr-read-limits";

export interface DepartmentCatalog {
  /** Lower-cased department name or code → org unit id. */
  byKey: Map<string, string>;
  /** Ids of the org's live, ACTIVE departments — the allowlist for a client-supplied `departmentId`. */
  activeIds: Set<string>;
  usedCodes: Set<string>;
  created: boolean;
}

/** One bounded keyset drain of the org's live departments, before any row is processed. */
export async function loadDepartmentCatalog(
  db: DbOrTx,
  orgId: string,
): Promise<DepartmentCatalog> {
  const catalog: DepartmentCatalog = {
    byKey: new Map(),
    activeIds: new Set(),
    usedCodes: new Set(),
    created: false,
  };

  let afterOrgUnitId = "";
  for (let page = 0; page < HR_SCAN_MAX_PAGES; page++) {
    const chunk = await db
      .select({ id: orgUnits.id, name: orgUnits.name, code: orgUnits.code })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "DEPARTMENT"),
          isNull(orgUnits.deletedAt),
          sql`${orgUnits.status} <> 'ARCHIVED'`,
          gt(orgUnits.id, afterOrgUnitId),
        ),
      )
      .orderBy(asc(orgUnits.id))
      .limit(HR_SCAN_PAGE);
    if (chunk.length === 0) break;
    for (const department of chunk) record(catalog, department);
    if (chunk.length < HR_SCAN_PAGE) break;
    afterOrgUnitId = chunk[chunk.length - 1].id;
  }

  return catalog;
}

function record(
  catalog: DepartmentCatalog,
  department: { id: string; name: string; code: string | null },
): void {
  catalog.byKey.set(department.name.trim().toLowerCase(), department.id);
  catalog.activeIds.add(department.id);
  if (department.code?.trim()) {
    catalog.byKey.set(department.code.trim().toLowerCase(), department.id);
    catalog.usedCodes.add(department.code);
  }
}

function allocateCode(catalog: DepartmentCatalog, name: string): string {
  const base = toDepartmentCode(name);
  let code = base;
  let suffix = 2;
  while (catalog.usedCodes.has(code)) {
    code = nextDepartmentCode(base, suffix);
    suffix += 1;
  }
  catalog.usedCodes.add(code);
  return code;
}

// Creates every department name the upload lacks in one multi-row INSERT plus at most one reconciling SELECT.
export async function ensureDepartments(
  db: DbOrTx,
  orgId: string,
  catalog: DepartmentCatalog,
  names: readonly string[],
): Promise<void> {
  const wanted = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!key || catalog.byKey.has(key) || wanted.has(key)) continue;
    wanted.set(key, name);
  }
  if (wanted.size === 0) return;

  const inserted = await db
    .insert(orgUnits)
    .values(
      [...wanted.values()].map((name) => ({
        orgId,
        kind: "DEPARTMENT" as const,
        name,
        code: allocateCode(catalog, name),
        status: "ACTIVE" as const,
      })),
    )
    .onConflictDoNothing({ target: [orgUnits.orgId, orgUnits.kind, orgUnits.code] })
    .returning({ id: orgUnits.id, name: orgUnits.name, code: orgUnits.code });

  for (const department of inserted) record(catalog, department);
  if (inserted.length > 0) catalog.created = true;

  const stillMissing = [...wanted.keys()].filter((key) => !catalog.byKey.has(key));
  if (stillMissing.length === 0) return;

  const found = await db
    .selectDistinctOn([sql`lower(${orgUnits.name})`], {
      id: orgUnits.id,
      name: orgUnits.name,
      code: orgUnits.code,
    })
    .from(orgUnits)
    .where(
      and(
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "DEPARTMENT"),
        isNull(orgUnits.deletedAt),
        inArray(sql`lower(${orgUnits.name})`, stillMissing),
      ),
    )
    .orderBy(sql`lower(${orgUnits.name})`, asc(orgUnits.id))
    .limit(stillMissing.length);
  for (const department of found) record(catalog, department);
}
