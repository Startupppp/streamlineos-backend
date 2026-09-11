import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  signDocuments,
  signEnvelopes,
  signFields,
  signRecipients,
  signTemplates,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignAuthMethodPolicy } from "./sign-auth-method.policy";
import { SignTokensService } from "./sign-tokens.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { buildTemplateSnapshot, parseTemplateSnapshot } from "./sign-template-snapshot";
import type {
  CreateTemplateInput,
  UpdateTemplateInput,
  CreateEnvelopeFromTemplateInput,
} from "./dto/e-sign.schemas";
import type { RequestActorContext } from "../../common/audit/actor-context";

@Injectable()
export class SignTemplatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
    private readonly tokens: SignTokensService,
    private readonly planLimits: PlanLimitsService,
    private readonly settings: SignSettingsService,
    private readonly authMethods: SignAuthMethodPolicy,
  ) {}

  async create(orgId: string, ownerMembershipId: number | null, input: CreateTemplateInput) {
    const [template] = await this.db
      .insert(signTemplates)
      .values({
        orgId,
        name: input.name,
        description: input.description,
        category: input.category,
        ownerMembershipId,
        templateJson: input.templateJson,
      })
      .returning();

    await this.audit.record({
      orgId,
      envelopeId: null,
      actorType: "internal_user",
      eventType: "template_created",
      eventMessage: `Created template "${template.name}"`,
    });
    return template;
  }

  /** Snapshots a draft envelope's documents/recipients-as-roles/fields into a reusable template. */
  async createFromEnvelope(orgId: string, ownerMembershipId: number | null, envelopeId: number, name: string) {
    const envelope = await this.db.query.signEnvelopes.findFirst({ where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)) });
    if (!envelope) throw new NotFoundException("Envelope not found");

    const [documents, recipients, fields] = await Promise.all([
      this.db.query.signDocuments.findMany({ where: and(eq(signDocuments.orgId, orgId), eq(signDocuments.envelopeId, envelopeId)), orderBy: (d, { asc }) => [asc(d.orderIndex)] }),
      this.db.query.signRecipients.findMany({ where: and(eq(signRecipients.orgId, orgId), eq(signRecipients.envelopeId, envelopeId)), orderBy: (r, { asc }) => [asc(r.routingOrder)] }),
      this.db.query.signFields.findMany({ where: and(eq(signFields.orgId, orgId), eq(signFields.envelopeId, envelopeId)) }),
    ]);

    const templateJson: Record<string, unknown> = { ...buildTemplateSnapshot({ envelope, documents, recipients, fields }) };
    return this.create(orgId, ownerMembershipId, { name, templateJson });
  }

  async update(orgId: string, templateId: number, input: UpdateTemplateInput, actor: RequestActorContext) {
    const template = await this.get(orgId, templateId);
    const [updated] = await this.db
      .update(signTemplates)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(signTemplates.id, templateId), eq(signTemplates.orgId, orgId)))
      .returning();

    if (input.status === "published" && template.status !== "published") {
      await this.audit.record({ orgId, envelopeId: null, actorType: "internal_user", actorUserId: actor.userId, eventType: "template_published", eventMessage: `Published template "${updated.name}"` });
    }
    if (input.status === "archived" && template.status !== "archived") {
      await this.audit.record({ orgId, envelopeId: null, actorType: "internal_user", actorUserId: actor.userId, eventType: "template_archived", eventMessage: `Archived template "${updated.name}"` });
    }
    return updated;
  }

  async duplicate(orgId: string, templateId: number, actor: RequestActorContext) {
    const template = await this.get(orgId, templateId);
    const [copy] = await this.db
      .insert(signTemplates)
      .values({
        orgId,
        name: `${template.name} (copy)`,
        description: template.description,
        category: template.category,
        ownerMembershipId: actor.membershipId,
        templateJson: template.templateJson,
        // `restrictedToRoles` / `restrictedToTeams` are deliberately NOT copied.
        // They were never enforced anywhere, and propagating them into new rows
        // spreads a setting that looks like an access control and is not one.
      })
      .returning();
    return copy;
  }

  async list(orgId: string) {
    return this.db.query.signTemplates.findMany({ where: eq(signTemplates.orgId, orgId), orderBy: (t, { desc }) => [desc(t.updatedAt)], limit: 100 });
  }

  async get(orgId: string, templateId: number) {
    const template = await this.db.query.signTemplates.findFirst({ where: and(eq(signTemplates.id, templateId), eq(signTemplates.orgId, orgId)) });
    if (!template) throw new NotFoundException("Template not found");
    return template;
  }

  /** Instantiates a draft envelope (documents + recipients + fields) from a template snapshot. */
  async instantiate(orgId: string, senderMembershipId: number | null, templateId: number, input: CreateEnvelopeFromTemplateInput) {
    const template = await this.get(orgId, templateId);
    const snapshot = parseTemplateSnapshot(template.templateJson);
    if (!snapshot.roles || snapshot.roles.length === 0) {
      throw new BadRequestException("This template has no recipient roles configured");
    }

    const providedRoles = new Set(input.recipients.map((r) => r.roleName));
    const missingRoles = snapshot.roles.filter((role) => !providedRoles.has(role.roleName));
    if (missingRoles.length > 0) {
      throw new BadRequestException(`Missing recipients for template role(s): ${missingRoles.map((r) => r.roleName).join(", ")}`);
    }

    /**
     * The snapshot's authentication methods go through the same gate a
     * recipient does, and before the envelope row exists rather than after.
     *
     * `createTemplateSchema` declares `templateJson` as
     * `z.record(z.string(), z.unknown())`, so a role's `authMethod` is not a
     * legacy value that leaked in — it is arbitrary caller input, replayed
     * verbatim into `signRecipients` on every instantiation. That let a holder
     * of `sign:template:manage` mint recipients on `sso`, `passkey`, `kba`,
     * `id_verification` or an undeliverable `otp_sms`, none of which
     * `authenticate` can complete.
     *
     * Bulk send drives exactly this path, once per row, so the same bad role
     * reaches as many customers as the org's row cap allows.
     */
    for (const role of snapshot.roles) {
      const provided = input.recipients.find((r) => r.roleName === role.roleName);
      await this.authMethods.assertUsable(
        orgId,
        role.authMethod as Parameters<SignAuthMethodPolicy["assertUsable"]>[1],
        provided?.phone,
        `template role "${role.roleName}"`,
      );
    }

    await this.planLimits.assertWithinLimit(orgId, "signEnvelopes");

    /** A template that predates the cadence fields inherits the org's, not a constant. */
    const orgSettings = await this.settings.getOrCreate(orgId);

    const [envelope] = await this.db
      .insert(signEnvelopes)
      .values({
        orgId,
        title: input.title ?? template.name,
        subject: snapshot.subject,
        message: snapshot.message,
        routingMode: snapshot.routingMode,
        ccTiming: snapshot.ccTiming,
        allowDecline: snapshot.allowDecline,
        templateId: template.id,
        watermarkPolicyId: snapshot.watermarkPolicyId ?? undefined,
        senderMembershipId,
        sourceModule: input.sourceModule,
        sourceEntityType: input.sourceEntityType,
        sourceEntityId: input.sourceEntityId,
        reminderEnabled: snapshot.reminderEnabled,
        reminderFirstAfterDays:
          snapshot.reminderFirstAfterDays ?? orgSettings.defaultReminderFirstAfterDays,
        reminderRepeatDays: snapshot.reminderRepeatDays ?? orgSettings.defaultReminderRepeatDays,
        reminderMaxCount: snapshot.reminderMaxCount ?? orgSettings.defaultReminderMaxCount,
      })
      .returning();

    const documentIdByIndex = new Map<number, number>();
    if (snapshot.documents.length > 0) {
      const insertedDocs = await this.db
        .insert(signDocuments)
        .values(
          snapshot.documents.map((doc) => ({
            orgId,
            envelopeId: envelope.id,
            originalFileKey: doc.fileKey,
            currentFileKey: doc.fileKey,
            fileName: doc.fileName,
            mimeType: doc.mimeType,
            pageCount: doc.pageCount,
            fileSize: doc.fileSize,
            sha256Hash: doc.sha256Hash,
            conversionStatus: "not_needed" as const,
            orderIndex: doc.orderIndex,
            createdByMembershipId: senderMembershipId,
          })),
        )
        .returning();
      for (let i = 0; i < insertedDocs.length; i++) {
        const doc = insertedDocs[i];
        if (doc) documentIdByIndex.set(i, doc.id);
      }
    }

    const recipientIdByRole = new Map<string, number>();
    const recipientInserts = snapshot.roles.flatMap((role) => {
      const provided = input.recipients.find((r) => r.roleName === role.roleName);
      if (!provided) return [];
      return [{ role, provided }];
    });
    if (recipientInserts.length > 0) {
      const insertedRecipients = await this.db
        .insert(signRecipients)
        .values(
          recipientInserts.map(({ role, provided }) => ({
            orgId,
            envelopeId: envelope.id,
            roleName: role.roleName,
            recipientType: role.recipientType,
            name: provided.name,
            email: provided.email,
            phone: provided.phone,
            routingOrder: role.routingOrder,
            authMethod: role.authMethod,
          })),
        )
        .returning();
      for (let i = 0; i < recipientInserts.length; i++) {
        const insert = recipientInserts[i];
        const row = insertedRecipients[i];
        if (insert && row) recipientIdByRole.set(insert.role.roleName, row.id);
      }
    }

    const fieldValues = snapshot.fields.flatMap((field) => {
      const recipientId = recipientIdByRole.get(field.roleName);
      const documentId = documentIdByIndex.get(field.documentIndex);
      if (!recipientId || !documentId) return [];
      return [
        {
          orgId,
          envelopeId: envelope.id,
          documentId,
          recipientId,
          fieldType: field.fieldType,
          label: field.label,
          pageNumber: field.pageNumber,
          x: field.x,
          y: field.y,
          width: field.width,
          height: field.height,
          required: field.required,
          readonly: field.readonly,
          orderIndex: field.orderIndex,
          groupId: field.groupId,
          defaultValue: field.defaultValue,
          optionsJson: field.optionsJson,
          validationType: field.validationType,
          validationRulesJson: field.validationRulesJson,
          conditionalRulesJson: field.conditionalRulesJson,
        },
      ];
    });
    if (fieldValues.length > 0) {
      await this.db.insert(signFields).values(fieldValues);
    }

    await this.audit.record({
      orgId,
      envelopeId: envelope.id,
      actorType: "internal_user",
      eventType: "envelope_created",
      eventMessage: `Created from template "${template.name}"`,
    });

    return envelope;
  }
}
