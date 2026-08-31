import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { signEnvelopes, signPublicForms, signRecipients } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { SignTemplatesService, parseTemplateSnapshot } from "./sign-templates.service";
import { SignSettingsService } from "./sign-settings.service";
import type { PublicFormESignSubmitInput } from "./dto/e-sign.schemas";

const SIGNING_RECIPIENT_TYPES = ["signer", "approver", "in_person_host", "internal_reviewer"];

export interface PublicRequestContext {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class SignPublicFormService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly tokens: SignTokensService,
    private readonly audit: SignAuditService,
    private readonly templates: SignTemplatesService,
    private readonly settings: SignSettingsService,
  ) {}

  async getPublicForm(slug: string) {
    return this.templates.getPublicForm(slug);
  }

  async submitPublicForm(slug: string, input: PublicFormESignSubmitInput, ctx: PublicRequestContext) {
    const form = await withPublicToken(this.db, slug, (tx) =>
      tx.query.signPublicForms.findFirst({ where: eq(signPublicForms.slug, slug) }),
    );
    if (!form || form.status !== "published") throw new NotFoundException("Form not found");
    if (form.expiresAt && form.expiresAt.getTime() < Date.now()) throw new NotFoundException("Form not found");
    if (form.maxSubmissions && form.submissionCount >= form.maxSubmissions)
      throw new ForbiddenException("This form is no longer accepting submissions");
    if (form.accessCodeHash && (!input.accessCode || this.tokens.hash(input.accessCode) !== form.accessCodeHash))
      throw new ForbiddenException("Invalid access code");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const template = await this.templates.get(form.orgId, form.templateId);
        const snapshot = parseTemplateSnapshot(template.templateJson);
        const signingRole = snapshot.roles.find((r) => SIGNING_RECIPIENT_TYPES.includes(r.recipientType));
        if (!signingRole) throw new BadRequestException("This form's template has no signer role configured");

        const envelope = await this.templates.instantiate(
          form.orgId,
          form.createdByMembershipId ?? template.ownerMembershipId ?? null,
          form.templateId,
          {
            recipients: [{ roleName: signingRole.roleName, name: input.name, email: input.email, phone: input.phone }],
            sourceModule: "public_form",
            sourceEntityId: String(form.id),
          },
        );

        const recipient = await tx.query.signRecipients.findFirst({ where: eq(signRecipients.envelopeId, envelope.id) });
        if (!recipient) throw new BadRequestException("Failed to create a signer for this submission");

        const orgSettings = await this.settings.getOrCreate(form.orgId);
        const expiresAt = new Date(Date.now() + orgSettings.defaultExpirationDays * 24 * 60 * 60 * 1000);
        const rawToken = this.tokens.generateSigningToken();

        await tx
          .update(signEnvelopes)
          .set({ status: "sent", sentAt: new Date(), expiresAt })
          .where(eq(signEnvelopes.id, envelope.id));
        await tx
          .update(signRecipients)
          .set({ status: "invited", signingTokenHash: this.tokens.hash(rawToken), tokenExpiresAt: expiresAt })
          .where(eq(signRecipients.id, recipient.id));
        await tx
          .update(signPublicForms)
          .set({ submissionCount: form.submissionCount + 1 })
          .where(eq(signPublicForms.id, form.id));

        await this.audit.record({
          orgId: form.orgId,
          envelopeId: envelope.id,
          recipientId: recipient.id,
          actorType: "external_signer",
          actorName: input.name,
          actorEmail: input.email,
          eventType: "public_form_submitted",
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
        });

        return {
          token: rawToken,
          recipientId: recipient.id,
          envelopeId: envelope.id,
          redirectUrl: form.completionRedirectUrl,
        };
      },
      { orgId: form.orgId },
    );
  }
}
