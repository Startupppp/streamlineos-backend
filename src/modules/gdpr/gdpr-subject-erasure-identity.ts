import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import {
  hrDependents,
  hrEmployeeSensitiveFields,
  hrEmployments,
  hrPeople,
  organizationMembers,
  organizationPeople,
  users,
} from "../../db/schema";
import type { TenantTx } from "../../db/drizzle.types";
import { ERASURE_ID_PAGE, drainIds } from "./gdpr-subject-erasure-paging";

export const ERASED_NAME = "ERASED";

export function hashSubjectId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

export interface SubjectIdentityScope {
  readonly orgId: string;
  readonly subjectUserId: string;
}

/**
 * Redacts the subject's identity columns inside one organization: the directory row,
 * the encrypted employment fields reached through their HR person records, and their
 * declared dependents. Returns the tables that actually changed, in write order.
 */
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
      and(eq(hrDependents.orgId, orgId), eq(hrDependents.userId, subjectUserId)),
    )
    .returning({ id: hrDependents.id });
  if (depResult.length > 0) tables.push("hr_dependents");

  return tables;
}

/**
 * The global `users` row is shared across every organization the subject belongs to,
 * so it may only be redacted once no other membership remains. Returns false when a
 * surviving membership keeps the identity alive.
 */
export async function anonymiseGlobalIdentity(
  tx: TenantTx,
  { orgId, subjectUserId }: SubjectIdentityScope,
): Promise<boolean> {
  const [otherMembership] = await tx
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, subjectUserId),
        ne(organizationMembers.orgId, orgId),
      ),
    )
    .limit(1);

  if (otherMembership) return false;

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
