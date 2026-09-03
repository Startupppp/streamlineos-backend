import { ConflictException, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { signPublicForms, signTemplates } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { isUniqueViolationOn } from "../../common/db/postgres-error";
import type { PublishPublicFormInput } from "./dto/e-sign.schemas";

export interface PublicFormPublication {
  orgId: string;
  templateId: number;
  createdByMembershipId: number | null;
  accessCodeHash: string | null;
  input: PublishPublicFormInput;
}

/**
 * `uniq_sign_public_forms_slug` is a GLOBAL unique index, because the slug is a
 * public URL and the namespace is the platform's, not the tenant's. A pre-flight
 * `findFirst` cannot see another organisation's row — RLS on
 * `sign_public_forms` admits `org_id = current_org_id() OR slug =
 * current_public_token()`, and an authenticated request sets no public token —
 * so a slug taken by another tenant used to pass the check and then break the
 * index, and the 23505 escaped as a 500. The insert is the only authority, and
 * both cases now answer the same 409 so the reply cannot separate "yours" from
 * "someone else's".
 */
export async function insertSignPublicForm(db: Db, publication: PublicFormPublication) {
  const { orgId, templateId, createdByMembershipId, accessCodeHash, input } = publication;
  try {
    const [form] = await db
      .insert(signPublicForms)
      .values({
        orgId,
        templateId,
        slug: input.slug,
        status: "published",
        accessCodeHash,
        maxSubmissions: input.maxSubmissions,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
        completionRedirectUrl: input.completionRedirectUrl,
        webhookUrl: input.webhookUrl,
        embedAllowed: input.embedAllowed,
        createdByMembershipId,
      })
      .returning();
    return form;
  } catch (err) {
    if (isUniqueViolationOn(err, "uniq_sign_public_forms_slug"))
      throw new ConflictException("This slug is already in use");
    throw err;
  }
}

/**
 * Resolves a public form by its slug for an unauthenticated visitor. Every way a
 * form can be unavailable — unpublished, expired, at its submission cap — answers
 * the same 404, so the reply never confirms that a slug exists.
 */
export async function loadSignPublicForm(db: Db, slug: string) {
  const form = await withPublicToken(db, slug, (tx) =>
    tx.query.signPublicForms.findFirst({ where: eq(signPublicForms.slug, slug) }),
  );
  if (!form || form.status !== "published") throw new NotFoundException("Form not found");
  if (form.expiresAt && form.expiresAt.getTime() < Date.now()) throw new NotFoundException("Form not found");
  if (form.maxSubmissions && form.submissionCount >= form.maxSubmissions) throw new NotFoundException("Form not found");

  return runInTenantTransaction(
    db,
    async (tx) => {
      const template = await tx.query.signTemplates.findFirst({ where: eq(signTemplates.id, form.templateId) });
      return { form: { slug: form.slug, requiresAccessCode: Boolean(form.accessCodeHash), embedAllowed: form.embedAllowed }, template };
    },
    { orgId: form.orgId },
  );
}
