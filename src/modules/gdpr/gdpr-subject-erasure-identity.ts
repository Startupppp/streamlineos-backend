import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import {
  hrDependents,
  hrEmployeeSensitiveFields,
  hrEmployments,
  hrPeople,
  organizationMembers,
  organizationPeople,
  organizations,
  users,
} from "../../db/schema";
import type { Db, TenantTx } from "../../db/drizzle.types";
import { runOutsideTenantContext } from "../../common/tenant/tenant-context";
import { withIdentity } from "../../common/tenant/with-identity";
import { drainIds } from "../../common/pagination/keyset-drain";
import { ERASURE_ID_PAGE } from "./gdpr-subject-erasure-paging";

export const ERASED_NAME = "ERASED";

export function hashSubjectId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

export interface SubjectIdentityScope {
  readonly orgId: string;
  readonly subjectUserId: string;
}

export async function anonymiseSubjectProfile(
  tx: TenantTx,
  { orgId, subjectUserId }: SubjectIdentityScope,
): Promise<string[]> {
  const tables: string[] = [];

  const opResult = await tx
    .update(organizationPeople)
    .set({
      firstName: ERASED_NAME,
      lastName: ERASED_NAME,
      displayName: null,
      preferredName: null,
      workEmail: null,
      personalEmail: null,
      phone: null,
      whatsappNumber: null,
      dateOfBirth: null,
      gender: null,
      nationality: null,
      address: null,
      emergencyContact: null,
      bio: null,
      linkedinUrl: null,
      githubUrl: null,
      avatarUrl: null,
    })
    .where(
      and(
        eq(organizationPeople.organizationId, orgId),
        eq(organizationPeople.userId, subjectUserId),
      ),
    )
    .returning({ id: organizationPeople.organizationPersonId });
  if (opResult.length > 0) tables.push("organization_people");

  // A bare `.limit(n)` here would report a partial erasure as a complete one.
  const peopleRows = await drainIds(ERASURE_ID_PAGE, (cursor) =>
    tx
      .select({ id: hrPeople.id })
      .from(hrPeople)
      .where(
        and(
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.userId, subjectUserId),
          isNull(hrPeople.deletedAt),
          ...(cursor === null ? [] : [gt(hrPeople.id, cursor)]),
        ),
      )
      .orderBy(asc(hrPeople.id))
      .limit(ERASURE_ID_PAGE),
  );

  if (peopleRows.length > 0) {
    const personIds = peopleRows.map((p) => p.id);
    const employmentRows = await drainIds(ERASURE_ID_PAGE, (cursor) =>
      tx
        .select({ id: hrEmployments.id })
        .from(hrEmployments)
        .where(
          and(
            eq(hrEmployments.orgId, orgId),
            inArray(hrEmployments.personId, personIds),
            isNull(hrEmployments.deletedAt),
            ...(cursor === null ? [] : [gt(hrEmployments.id, cursor)]),
          ),
        )
        .orderBy(asc(hrEmployments.id))
        .limit(ERASURE_ID_PAGE),
    );

    if (employmentRows.length > 0) {
      const employmentIds = employmentRows.map((e) => e.id);
      const sfResult = await tx
        .update(hrEmployeeSensitiveFields)
        .set({
          bankDetails: null,
          encryptionKeyRef: null,
          taxId: null,
          panNumber: null,
          nationalId: null,
          passportNumber: null,
          passportExpiry: null,
          visaType: null,
          visaExpiry: null,
          medicalNotes: null,
          bloodGroup: null,
          disciplinaryRecords: null,
          grievanceRecords: null,
        })
        .where(
          and(
            eq(hrEmployeeSensitiveFields.orgId, orgId),
            inArray(hrEmployeeSensitiveFields.employmentId, employmentIds),
          ),
        )
        .returning({ id: hrEmployeeSensitiveFields.id });
      if (sfResult.length > 0) tables.push("hr_employee_sensitive_fields");
    }
  }

  const depResult = await tx
    .update(hrDependents)
    .set({ name: ERASED_NAME, dateOfBirth: null })
    .where(
      and(
        eq(hrDependents.orgId, orgId),
        eq(hrDependents.userId, subjectUserId),
      ),
    )
    .returning({ id: hrDependents.id });
  if (depResult.length > 0) tables.push("hr_dependents");

  return tables;
}

export function subjectHasSurvivingMembership(
  db: Db,
  { orgId, subjectUserId }: SubjectIdentityScope,
): Promise<boolean> {
  return runOutsideTenantContext(() =>
    withIdentity(db, subjectUserId, async (tx) => {
      const [survivor] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .innerJoin(
          organizations,
          eq(organizations.id, organizationMembers.orgId),
        )
        .where(
          and(
            eq(organizationMembers.userId, subjectUserId),
            ne(organizationMembers.orgId, orgId),
            inArray(organizationMembers.status, ["ACTIVE", "SUSPENDED"]),
            eq(organizations.status, "ACTIVE"),
            isNull(organizations.deletedAt),
          ),
        )
        .limit(1);
      return survivor !== undefined;
    }),
  );
}

export async function anonymiseGlobalIdentity(
  tx: TenantTx,
  { subjectUserId }: SubjectIdentityScope,
  { hasSurvivingMembership }: { readonly hasSurvivingMembership: boolean },
): Promise<boolean> {
  if (hasSurvivingMembership) return false;

  await tx
    .update(users)
    .set({
      name: ERASED_NAME,
      firstName: ERASED_NAME,
      lastName: ERASED_NAME,
      email: `erased-${hashSubjectId(subjectUserId)}@erased.invalid`,
      phone: null,
      whatsappNumber: null,
      dateOfBirth: null,
      gender: null,
      emergencyContact: null,
      bio: null,
      image: null,
      linkedinUrl: null,
      twitterUrl: null,
      githubUrl: null,
      websiteUrl: null,
      metadata: null,
    })
    .where(eq(users.id, subjectUserId));
  return true;
}
