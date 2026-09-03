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
import type { Db, TenantTx } from "../../db/drizzle.types";
import { runOutsideTenantContext } from "../../common/tenant/tenant-context";
import { withIdentity } from "../../common/tenant/with-identity";
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
 * Answers "does a membership outside `orgId` still keep this identity alive?".
 *
 * THIS QUESTION CANNOT BE ASKED FROM INSIDE THE ERASING TENANT TRANSACTION, which is
 * where it used to be asked. `organization_members` carries
 * `USING ((org_id = app.current_org_id_or_null()) OR (user_id = app.current_user_id_or_null()))`
 * and a tenant transaction sets only `app.organization_id` (with-tenant.ts:127) —
 * `app.user_id` is set in exactly one place in this repository, `with-identity.ts:28`.
 * So under a role RLS actually applies to, BOTH disjuncts fail for another org's row
 * and the read returns nothing. Measured on a database at journal head as
 * `streamline_app`, for a subject holding memberships in orgs A and B, asking from
 * org A's tenant transaction:
 *
 *   owner (BYPASSRLS)                         → 1 row
 *   app role, app.organization_id = A         → 0 rows   ← the guard always said "none"
 *   app role, same query, app.user_id = subject → 1 row
 *   app role, control read of A's own row      → 1 row   (the connection works)
 *
 * A blind guard here is not a missing feature: `users` has `relrowsecurity = f`, so the
 * redaction below is unimpeded and a multi-org subject loses the account they still use
 * in the OTHER controller's tenant — irreversibly, and in the opposite direction from
 * the usual privacy failure.
 *
 * `withIdentity` is this repository's answer to exactly this ordering problem, and
 * `runOutsideTenantContext` is what makes it a real transaction on its own connection
 * rather than a savepoint on the tenant one — a savepoint would leave `app.user_id` set
 * for the remainder of the erasure, widening every later read in it to the subject's
 * rows in every other org. Three sibling call sites already reach this same fact this
 * way: `org-membership-access-revocation.ts:321`, `org-lifecycle.service.ts:109` and
 * `org-purge.service.ts:132`.
 *
 * The PREDICATE is deliberately unchanged — any membership row in any other org, whatever
 * its status. The revocation sibling additionally requires `status = 'ACTIVE'` on both
 * sides, which is right for "should we kill their sessions" and wrong here: narrowing it
 * would newly erase the identity of a subject whose only other membership is suspended,
 * moving the compliance failure rather than fixing it. Only the CONTEXT was wrong.
 *
 * Call this BEFORE opening the erasure transaction, not inside it. The borrow of a second
 * pooled connection is unavoidable either way (the request's own tenant transaction is
 * already open around the whole handler), but asking first means the wait for a pool slot
 * does not happen while the erasure holds row locks on the subject's PII.
 */
export function subjectHasSurvivingMembership(
  db: Db,
  { orgId, subjectUserId }: SubjectIdentityScope,
): Promise<boolean> {
  return runOutsideTenantContext(() =>
    withIdentity(db, subjectUserId, async (tx) => {
      const [survivor] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, subjectUserId),
            ne(organizationMembers.orgId, orgId),
          ),
        )
        .limit(1);
      return survivor !== undefined;
    }),
  );
}

/**
 * The global `users` row is shared across every organization the subject belongs to,
 * so it may only be redacted once no other membership remains. Returns false when a
 * surviving membership keeps the identity alive.
 *
 * The answer is a REQUIRED ARGUMENT rather than a query, because `tx` is the erasing
 * org's tenant transaction and is structurally unable to see another org's membership
 * row — see `subjectHasSurvivingMembership`, which is the only context that can.
 */
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
