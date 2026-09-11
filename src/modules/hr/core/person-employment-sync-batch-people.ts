import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { organizationPeople } from "../../../db/schema/directory/organization-people";
import { hrPeople } from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { EnsureManyInput } from "./person-employment-sync-batch.types";

export function canonicalEmail(value: string): string {
  return value.trim().toLowerCase();
}

export async function resolveOrganizationPeople(
  tx: DbOrTx,
  orgId: string,
  inputs: readonly EnsureManyInput[],
): Promise<Map<string, string>> {
  const userIds = [...new Set(inputs.map((input) => input.userId))];
  const emails = [...new Set(inputs.map((input) => canonicalEmail(input.workEmail)))];

  const existing = await tx
    .select({
      organizationPersonId: organizationPeople.organizationPersonId,
      userId: organizationPeople.userId,
      workEmail: organizationPeople.workEmail,
    })
    .from(organizationPeople)
    .where(
      and(
        eq(organizationPeople.organizationId, orgId),
        isNull(organizationPeople.deletedAt),
        or(
          inArray(organizationPeople.userId, userIds),
          inArray(sql`lower(trim(${organizationPeople.workEmail}))`, emails),
        ),
      ),
    )
    .limit(userIds.length + emails.length);

  const byUserId = new Map<string, string>();
  const byEmail = new Map<string, string>();
  for (const row of existing) {
    if (row.userId) byUserId.set(row.userId, row.organizationPersonId);
    if (row.workEmail) byEmail.set(canonicalEmail(row.workEmail), row.organizationPersonId);
  }

  const resolved = new Map<string, string>();
  const missing: EnsureManyInput[] = [];
  for (const input of inputs) {
    const found =
      byUserId.get(input.userId) ?? byEmail.get(canonicalEmail(input.workEmail));
    if (found) resolved.set(input.userId, found);
    else missing.push(input);
  }

  if (missing.length > 0) {
    const inserted = await tx
      .insert(organizationPeople)
      .values(
        missing.map((input) => ({
          organizationId: orgId,
          userId: input.userId,
          firstName: input.firstName,
          lastName: input.lastName,
          workEmail: canonicalEmail(input.workEmail),
          phone: input.phone ?? null,
        })),
      )
      .returning({
        organizationPersonId: organizationPeople.organizationPersonId,
        userId: organizationPeople.userId,
      });
    for (const row of inserted) if (row.userId) resolved.set(row.userId, row.organizationPersonId);
  }

  return resolved;
}

export async function resolveHrPeople(
  tx: DbOrTx,
  orgId: string,
  inputs: readonly EnsureManyInput[],
  orgPersonByUserId: Map<string, string>,
): Promise<{ personIdByUserId: Map<string, number>; createdUserIds: Set<string> }> {
  const userIds = [...new Set(inputs.map((input) => input.userId))];
  const orgPersonIds = [...new Set([...orgPersonByUserId.values()])];

  const existing = await tx
    .select({
      id: hrPeople.id,
      userId: hrPeople.userId,
      organizationPersonId: hrPeople.organizationPersonId,
    })
    .from(hrPeople)
    .where(
      and(
        eq(hrPeople.orgId, orgId),
        isNull(hrPeople.deletedAt),
        or(
          inArray(hrPeople.userId, userIds),
          inArray(hrPeople.organizationPersonId, orgPersonIds),
        ),
      ),
    )
    .limit(userIds.length + orgPersonIds.length);

  const byUserId = new Map<string, number>();
  const byOrgPersonId = new Map<string, number>();
  for (const row of existing) {
    if (row.userId) byUserId.set(row.userId, row.id);
    if (row.organizationPersonId) byOrgPersonId.set(row.organizationPersonId, row.id);
  }

  const personIdByUserId = new Map<string, number>();
  const relink: Array<{ personId: number; userId: string }> = [];
  const missing: EnsureManyInput[] = [];

  for (const input of inputs) {
    const direct = byUserId.get(input.userId);
    if (direct !== undefined) {
      personIdByUserId.set(input.userId, direct);
      continue;
    }
    const orgPersonId = orgPersonByUserId.get(input.userId);
    const linked = orgPersonId === undefined ? undefined : byOrgPersonId.get(orgPersonId);
    if (linked !== undefined) {
      personIdByUserId.set(input.userId, linked);
      relink.push({ personId: linked, userId: input.userId });
      continue;
    }
    missing.push(input);
  }

  if (relink.length > 0) {
    const pairs = sql.join(
      relink.map((entry) => sql`(${entry.personId}::int, ${entry.userId}::text)`),
      sql`, `,
    );
    await tx.execute(
      sql`UPDATE hr_people AS p SET user_id = v.user_id, updated_at = now() FROM (VALUES ${pairs}) AS v(id, user_id) WHERE p.id = v.id AND p.org_id = ${orgId}`,
    );
  }

  const createdUserIds = new Set<string>();
  if (missing.length > 0) {
    const inserted = await tx
      .insert(hrPeople)
      .values(
        missing.map((input) => ({
          orgId,
          userId: input.userId,
          organizationPersonId: orgPersonByUserId.get(input.userId) ?? null,
        })),
      )
      .returning({ id: hrPeople.id, userId: hrPeople.userId });
    for (const row of inserted) {
      if (!row.userId) continue;
      personIdByUserId.set(row.userId, row.id);
      createdUserIds.add(row.userId);
    }
  }

  return { personIdByUserId, createdUserIds };
}

