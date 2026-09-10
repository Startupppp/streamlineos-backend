import { ConflictException } from "@nestjs/common";
import { and, eq, ilike, isNull, or, type SQLWrapper } from "drizzle-orm";
import { organizationMembers, orgUnits } from "../../../db/schema";
import type { AuditService } from "../../../common/audit/audit.service";
import { type Db } from "../../../db/drizzle.module";
import type { ListQueryInput } from "./dto/org-hierarchy.schemas";
import type { OrgUnitKind } from "./org-hierarchy-dependencies.service";
import {
  getOrgUnitCursorFilter,
  getOrgUnitStatusFilter,
} from "./org-hierarchy-list-filters";

export type OrgUnitSearchExtension = (pattern: string) => SQLWrapper;

export interface OrgUnitListFilterOptions {
  orgId: string;
  kind: OrgUnitKind;
  query: ListQueryInput;
  searchExtension?: OrgUnitSearchExtension;
}

function orgUnitSearchFilter(search: string, extension?: OrgUnitSearchExtension) {
  const pattern = `%${search}%`;
  return or(
    ilike(orgUnits.name, pattern),
    ilike(orgUnits.code, pattern),
    ...(extension ? [extension(pattern)] : []),
  );
}

export function getOrgUnitListFilter({
  orgId,
  kind,
  query,
  searchExtension,
}: OrgUnitListFilterOptions) {
  const statusFilter = getOrgUnitStatusFilter(query.status);
  const cursorFilter = getOrgUnitCursorFilter(query.cursor);
  const searchFilter = query.search
    ? orgUnitSearchFilter(query.search, searchExtension)
    : undefined;
  return and(
    eq(orgUnits.orgId, orgId),
    eq(orgUnits.kind, kind),
    isNull(orgUnits.deletedAt),
    ...(searchFilter ? [searchFilter] : []),
    ...(statusFilter ? [statusFilter] : []),
    ...(cursorFilter ? [cursorFilter] : []),
  );
}

export function getOrgUnitRowFilter(orgId: string, kind: OrgUnitKind, id: string) {
  return and(
    eq(orgUnits.id, id),
    eq(orgUnits.orgId, orgId),
    eq(orgUnits.kind, kind),
    isNull(orgUnits.deletedAt),
  );
}

export function getOrgUnitWriteFilter(orgId: string, kind: OrgUnitKind, id: string) {
  return and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, kind));
}

export interface OrgUnitCodeCheck {
  db: Db;
  orgId: string;
  kind: OrgUnitKind;
  code: string;
  label: string;
  includeDeleted?: boolean;
}

export async function assertOrgUnitCodeAvailable({
  db,
  orgId,
  kind,
  code,
  label,
  includeDeleted = false,
}: OrgUnitCodeCheck): Promise<void> {
  const conflict = await db.query.orgUnits.findFirst({
    columns: { id: true },
    where: and(
      eq(orgUnits.orgId, orgId),
      eq(orgUnits.kind, kind),
      eq(orgUnits.code, code),
      ...(includeDeleted ? [] : [isNull(orgUnits.deletedAt)]),
    ),
  });
  if (conflict) throw new ConflictException(`${label} code already exists`);
}

/**
 * Tri-state on purpose: `undefined` means the caller sent no head at all and the
 * column must be left untouched, while `null` means an explicit clear.
 */
export async function resolveOrgUnitHeadMembershipId(
  db: Db,
  orgId: string,
  userId: string | null | undefined,
): Promise<number | null | undefined> {
  if (userId === undefined) return undefined;
  if (!userId) return null;
  const [member] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
    )
    .limit(1);
  return member?.id ?? null;
}

export interface OrgUnitAuditEvent {
  action: string;
  userId: string;
  orgId: string;
  targetId: string;
}

export async function recordOrgUnitAudit(
  audit: AuditService,
  event: OrgUnitAuditEvent,
): Promise<void> {
  await audit.logCritical({ ...event, targetType: "org_unit" });
}
