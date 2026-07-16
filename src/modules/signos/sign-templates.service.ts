import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  signDocuments,
  signEnvelopes,
  signFields,
  signPublicForms,
  signRecipients,
  signTemplates,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { PlanLimitsService } from "../billing/plan-limits.service";
import type { SignActorContext } from "./sign-recipients.service";
import type {
  CreateTemplateInput,
  UpdateTemplateInput,
  CreateEnvelopeFromTemplateInput,
  PublishPublicFormInput,
} from "./dto/signos.schemas";

export interface TemplateRole {
  roleName: string;
  recipientType: string;
  routingOrder: number;
  authMethod: string;
}

export interface TemplateDocument {
  fileKey: string;
  fileName: string;
  mimeType: string;
  pageCount: number | null;
  fileSize: number;
  sha256Hash: string;
  orderIndex: number;
}

export interface TemplateField {
  roleName: string;
  documentIndex: number;
  fieldType: string;
  label?: string | null;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  readonly: boolean;
  orderIndex: number;
  groupId?: string | null;
  defaultValue?: string | null;
  optionsJson?: string[] | null;
  validationType?: string | null;
  validationRulesJson?: Record<string, unknown> | null;
  conditionalRulesJson?: Record<string, unknown> | null;
}

export interface TemplateSnapshot {
  subject?: string;
  message?: string;
  routingMode: string;
  ccTiming: string;
  allowDecline: boolean;
  expirationDays: number;
  reminderEnabled: boolean;
  reminderFirstAfterDays: number;
  reminderRepeatDays: number;
  reminderMaxCount: number;
  watermarkPolicyId?: number | null;
  roles: TemplateRole[];
  documents: TemplateDocument[];
  fields: TemplateField[];
}

@Injectable()
export class SignTemplatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
    private readonly tokens: SignTokensService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async create(orgId: string, userId: string, input: CreateTemplateInput) {
    const [template] = await this.db
      .insert(signTemplates)
      .values({
        orgId,
        name: input.name,
        description: input.description,
        category: input.category,
        ownerUserId: userId,
        templateJson: input.templateJson,
        restrictedToRoles: input.restrictedToRoles,
        restrictedToTeams: input.restrictedToTeams,
      })
      .returning();

    await this.audit.record({
      orgId,
      envelopeId: null,
      actorType: "internal_user",
      actorUserId: userId,
      eventType: "template_created",
      eventMessage: `Created template "${template.name}"`,
    });
    return template;
  }

  /** Snapshots a draft envelope's documents/recipients-as-roles/fields into a reusable template. */
  async createFromEnvelope(orgId: string, userId: string, envelopeId: number, name: string) {
    const envelope = await this.db.query.signEnvelopes.findFirst({ where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)) });
    if (!envelope) throw new NotFoundException("Envelope not found");

    const [documents, recipients, fields] = await Promise.all([
      this.db.query.signDocuments.findMany({ where: and(eq(signDocuments.orgId, orgId), eq(signDocuments.envelopeId, envelopeId)), orderBy: (d, { asc }) => [asc(d.orderIndex)] }),
      this.db.query.signRecipients.findMany({ where: and(eq(signRecipients.orgId, orgId), eq(signRecipients.envelopeId, envelopeId)), orderBy: (r, { asc }) => [asc(r.routingOrder)] }),
      this.db.query.signFields.findMany({ where: and(eq(signFields.orgId, orgId), eq(signFields.envelopeId, envelopeId)) }),
    ]);

    const documentIndexById = new Map(documents.map((d, idx) => [d.id, idx]));
    const recipientRoleById = new Map(recipients.map((r) => [r.id, r.roleName]));

    const snapshot: TemplateSnapshot = {
      subject: envelope.subject ?? undefined,
      message: envelope.message ?? undefined,
      routingMode: envelope.routingMode,
      ccTiming: envelope.ccTiming,
      allowDecline: envelope.allowDecline,
      expirationDays: 30,
      reminderEnabled: envelope.reminderEnabled,
      reminderFirstAfterDays: envelope.reminderFirstAfterDays,
      reminderRepeatDays: envelope.reminderRepeatDays,
      reminderMaxCount: envelope.reminderMaxCount,
      watermarkPolicyId: envelope.watermarkPolicyId,
      roles: recipients.map((r) => ({
        roleName: r.roleName,
        recipientType: r.recipientType,
        routingOrder: r.routingOrder,
        authMethod: r.authMethod,
      })),
      documents: documents.map((d) => ({
        fileKey: d.currentFileKey,
        fileName: d.fileName,
        mimeType: d.mimeType,
        pageCount: d.pageCount,
        fileSize: d.fileSize,
        sha256Hash: d.sha256Hash,
        orderIndex: d.orderIndex,
      })),
      fields: fields.map((f) => ({
        roleName: recipientRoleById.get(f.recipientId) ?? "",
        documentIndex: documentIndexById.get(f.documentId) ?? 0,
        fieldType: f.fieldType,
        label: f.label,
        pageNumber: f.pageNumber,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        required: f.required,
        readonly: f.readonly,
        orderIndex: f.orderIndex,
        groupId: f.groupId,
        defaultValue: f.defaultValue,
        optionsJson: f.optionsJson,
        validationType: f.validationType,
        validationRulesJson: f.validationRulesJson,
        conditionalRulesJson: f.conditionalRulesJson,
      })),
    };

    return this.create(orgId, userId, { name, templateJson: snapshot as unknown as Record<string, unknown>, restrictedToRoles: [], restrictedToTeams: [] });
  }

  async update(orgId: string, templateId: number, input: UpdateTemplateInput, actor: SignActorContext) {
    const template = await this.get(orgId, templateId);
    const [updated] = await this.db
      .update(signTemplates)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(signTemplates.id, templateId))
      .returning();

    if (input.status === "published" && template.status !== "published") {
      await this.audit.record({ orgId, envelopeId: null, actorType: "internal_user", actorUserId: actor.userId, eventType: "template_published", eventMessage: `Published template "${updated.name}"` });
    }
    if (input.status === "archived" && template.status !== "archived") {
      await this.audit.record({ orgId, envelopeId: null, actorType: "internal_user", actorUserId: actor.userId, eventType: "template_archived", eventMessage: `Archived template "${updated.name}"` });
    }
    return updated;
  }

  async duplicate(orgId: string, templateId: number, actor: SignActorContext) {
    const template = await this.get(orgId, templateId);
    const [copy] = await this.db
      .insert(signTemplates)
      .values({
        orgId,
        name: `${template.name} (copy)`,
        description: template.description,
        category: template.category,
        ownerUserId: actor.userId,
        templateJson: template.templateJson,
        restrictedToRoles: template.restrictedToRoles,
        restrictedToTeams: template.restrictedToTeams,
      })
      .returning();
    return copy;
  }

  async list(orgId: string) {
    return this.db.query.signTemplates.findMany({ where: eq(signTemplates.orgId, orgId), orderBy: (t, { desc }) => [desc(t.updatedAt)] });
  }

  async get(orgId: string, templateId: number) {
    const template = await this.db.query.signTemplates.findFirst({ where: and(eq(signTemplates.id, templateId), eq(signTemplates.orgId, orgId)) });
    if (!template) throw new NotFoundException("Template not found");
    return template;
  }

  /** Instantiates a draft envelope (documents + recipients + fields) from a template snapshot. */
  async instantiate(orgId: string, userId: string, templateId: number, input: CreateEnvelopeFromTemplateInput) {
    const template = await this.get(orgId, templateId);
    const snapshot = template.templateJson as unknown as TemplateSnapshot;
    if (!snapshot.roles || snapshot.roles.length === 0) {
      throw new BadRequestException("This template has no recipient roles configured");
    }

    const providedRoles = new Set(input.recipients.map((r) => r.roleName));
    const missingRoles = snapshot.roles.filter((role) => !providedRoles.has(role.roleName));
    if (missingRoles.length > 0) {
      throw new BadRequestException(`Missing recipients for template role(s): ${missingRoles.map((r) => r.roleName).join(", ")}`);
    }

    await this.planLimits.assertWithinLimit(orgId, "signEnvelopes");

    const [envelope] = await this.db
      .insert(signEnvelopes)
      .values({
        orgId,
        title: input.title ?? template.name,
        subject: snapshot.subject,
        message: snapshot.message,
        routingMode: snapshot.routingMode as "parallel" | "sequential" | "mixed",
        ccTiming: snapshot.ccTiming as "on_send" | "on_complete",
        allowDecline: snapshot.allowDecline,
        templateId: template.id,
        watermarkPolicyId: snapshot.watermarkPolicyId ?? undefined,
        senderUserId: userId,
        sourceModule: input.sourceModule,
        sourceEntityType: input.sourceEntityType,
        sourceEntityId: input.sourceEntityId,
        reminderEnabled: snapshot.reminderEnabled,
        reminderFirstAfterDays: snapshot.reminderFirstAfterDays,
        reminderRepeatDays: snapshot.reminderRepeatDays,
        reminderMaxCount: snapshot.reminderMaxCount,
      })
      .returning();

    const documentIdByIndex = new Map<number, number>();
    for (let i = 0; i < snapshot.documents.length; i++) {
      const doc = snapshot.documents[i];
      const [inserted] = await this.db
        .insert(signDocuments)
        .values({
          orgId,
          envelopeId: envelope.id,
          originalFileKey: doc.fileKey,
          currentFileKey: doc.fileKey,
          fileName: doc.fileName,
          mimeType: doc.mimeType,
          pageCount: doc.pageCount,
          fileSize: doc.fileSize,
          sha256Hash: doc.sha256Hash,
          conversionStatus: "not_needed",
          orderIndex: doc.orderIndex,
          createdBy: userId,
        })
        .returning();
      documentIdByIndex.set(i, inserted.id);
    }

    const recipientIdByRole = new Map<string, number>();
    for (const role of snapshot.roles) {
      const provided = input.recipients.find((r) => r.roleName === role.roleName);
      if (!provided) continue;
      const [inserted] = await this.db
        .insert(signRecipients)
        .values({
          orgId,
          envelopeId: envelope.id,
          roleName: role.roleName,
          recipientType: role.recipientType as "signer" | "approver" | "cc" | "viewer" | "in_person_host" | "internal_reviewer",
          name: provided.name,
          email: provided.email,
          phone: provided.phone,
          routingOrder: role.routingOrder,
          authMethod: role.authMethod as "email_link" | "access_code" | "otp_email" | "otp_sms" | "sso" | "passkey" | "kba" | "id_verification",
        })
        .returning();
      recipientIdByRole.set(role.roleName, inserted.id);
    }

    for (const field of snapshot.fields) {
      const recipientId = recipientIdByRole.get(field.roleName);
      const documentId = documentIdByIndex.get(field.documentIndex);
      if (!recipientId || !documentId) continue;
      await this.db.insert(signFields).values({
        orgId,
        envelopeId: envelope.id,
        documentId,
        recipientId,
        fieldType: field.fieldType as typeof signFields.$inferInsert.fieldType,
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
      });
    }

    await this.audit.record({
      orgId,
      envelopeId: envelope.id,
      actorType: "internal_user",
      actorUserId: userId,
      eventType: "envelope_created",
      eventMessage: `Created from template "${template.name}"`,
    });

    return envelope;
  }

  async publishPublicForm(orgId: string, userId: string, templateId: number, input: PublishPublicFormInput) {
    const template = await this.get(orgId, templateId);
    if (template.status !== "published") throw new ForbiddenException("Only published templates can be turned into a public form");

    const existingSlug = await this.db.query.signPublicForms.findFirst({ where: eq(signPublicForms.slug, input.slug) });
    if (existingSlug) throw new BadRequestException("This slug is already in use");

    const [form] = await this.db
      .insert(signPublicForms)
      .values({
        orgId,
        templateId,
        slug: input.slug,
        status: "published",
        accessCodeHash: input.accessCode ? this.tokens.hash(input.accessCode) : null,
        maxSubmissions: input.maxSubmissions,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
        completionRedirectUrl: input.completionRedirectUrl,
        webhookUrl: input.webhookUrl,
        embedAllowed: input.embedAllowed,
        createdBy: userId,
      })
      .returning();

    await this.audit.record({
      orgId,
      envelopeId: null,
      actorType: "internal_user",
      actorUserId: userId,
      eventType: "public_form_published",
      eventMessage: `Published public form at /${input.slug}`,
    });

    return form;
  }

  async getPublicForm(slug: string) {
    const form = await this.db.query.signPublicForms.findFirst({ where: eq(signPublicForms.slug, slug) });
    if (!form || form.status !== "published") throw new NotFoundException("Form not found");
    if (form.expiresAt && form.expiresAt.getTime() < Date.now()) throw new NotFoundException("Form not found");
    if (form.maxSubmissions && form.submissionCount >= form.maxSubmissions) throw new NotFoundException("Form not found");

    const template = await this.db.query.signTemplates.findFirst({ where: eq(signTemplates.id, form.templateId) });
    return { form: { slug: form.slug, requiresAccessCode: Boolean(form.accessCodeHash), embedAllowed: form.embedAllowed }, template };
  }
}
