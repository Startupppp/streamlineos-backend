import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
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
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import type {
  CreateTemplateInput,
  UpdateTemplateInput,
  CreateEnvelopeFromTemplateInput,
  PublishPublicFormInput,
} from "./dto/e-sign.schemas";
import { isUniqueViolationOn } from "../../common/db/postgres-error";
import type { RequestActorContext } from "../../common/audit/actor-context";

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

export function parseTemplateSnapshot(json: Record<string, unknown>): TemplateSnapshot {
  const parseRole = (r: unknown): TemplateRole => {
    const o = typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {};
    return {
      roleName: String(o["roleName"] ?? ""),
      recipientType: String(o["recipientType"] ?? "signer"),
      routingOrder: typeof o["routingOrder"] === "number" ? o["routingOrder"] : 0,
      authMethod: String(o["authMethod"] ?? "email_link"),
    };
  };
  const parseDocument = (d: unknown): TemplateDocument => {
    const o = typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {};
    return {
      fileKey: String(o["fileKey"] ?? ""),
      fileName: String(o["fileName"] ?? ""),
      mimeType: String(o["mimeType"] ?? ""),
      pageCount: typeof o["pageCount"] === "number" ? o["pageCount"] : null,
      fileSize: typeof o["fileSize"] === "number" ? o["fileSize"] : 0,
      sha256Hash: String(o["sha256Hash"] ?? ""),
      orderIndex: typeof o["orderIndex"] === "number" ? o["orderIndex"] : 0,
    };
  };
  const parseField = (f: unknown): TemplateField => {
    const o = typeof f === "object" && f !== null ? (f as Record<string, unknown>) : {};
    return {
      roleName: String(o["roleName"] ?? ""),
      documentIndex: typeof o["documentIndex"] === "number" ? o["documentIndex"] : 0,
      fieldType: String(o["fieldType"] ?? ""),
      label: o["label"] != null ? String(o["label"]) : null,
      pageNumber: typeof o["pageNumber"] === "number" ? o["pageNumber"] : 1,
      x: typeof o["x"] === "number" ? o["x"] : 0,
      y: typeof o["y"] === "number" ? o["y"] : 0,
      width: typeof o["width"] === "number" ? o["width"] : 0,
      height: typeof o["height"] === "number" ? o["height"] : 0,
      required: Boolean(o["required"]),
      readonly: Boolean(o["readonly"]),
      orderIndex: typeof o["orderIndex"] === "number" ? o["orderIndex"] : 0,
      groupId: o["groupId"] != null ? String(o["groupId"]) : null,
      defaultValue: o["defaultValue"] != null ? String(o["defaultValue"]) : null,
      optionsJson: Array.isArray(o["optionsJson"]) ? o["optionsJson"].map(String) : null,
      validationType: o["validationType"] != null ? String(o["validationType"]) : null,
      validationRulesJson: typeof o["validationRulesJson"] === "object" && o["validationRulesJson"] !== null ? (o["validationRulesJson"] as Record<string, unknown>) : null,
      conditionalRulesJson: typeof o["conditionalRulesJson"] === "object" && o["conditionalRulesJson"] !== null ? (o["conditionalRulesJson"] as Record<string, unknown>) : null,
    };
  };
  return {
    subject: json["subject"] != null ? String(json["subject"]) : undefined,
    message: json["message"] != null ? String(json["message"]) : undefined,
    routingMode: String(json["routingMode"] ?? "parallel"),
    ccTiming: String(json["ccTiming"] ?? "on_complete"),
    allowDecline: Boolean(json["allowDecline"]),
    expirationDays: typeof json["expirationDays"] === "number" ? json["expirationDays"] : 30,
    reminderEnabled: Boolean(json["reminderEnabled"]),
    reminderFirstAfterDays: typeof json["reminderFirstAfterDays"] === "number" ? json["reminderFirstAfterDays"] : 3,
    reminderRepeatDays: typeof json["reminderRepeatDays"] === "number" ? json["reminderRepeatDays"] : 2,
    reminderMaxCount: typeof json["reminderMaxCount"] === "number" ? json["reminderMaxCount"] : 3,
    watermarkPolicyId: typeof json["watermarkPolicyId"] === "number" ? json["watermarkPolicyId"] : null,
    roles: Array.isArray(json["roles"]) ? json["roles"].map(parseRole) : [],
    documents: Array.isArray(json["documents"]) ? json["documents"].map(parseDocument) : [],
    fields: Array.isArray(json["fields"]) ? json["fields"].map(parseField) : [],
  };
}

@Injectable()
export class SignTemplatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
    private readonly tokens: SignTokensService,
    private readonly planLimits: PlanLimitsService,
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
        restrictedToRoles: input.restrictedToRoles,
        restrictedToTeams: input.restrictedToTeams,
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

    const templateJson: Record<string, unknown> = { ...snapshot };
    return this.create(orgId, ownerMembershipId, { name, templateJson, restrictedToRoles: [], restrictedToTeams: [] });
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
        restrictedToRoles: template.restrictedToRoles,
        restrictedToTeams: template.restrictedToTeams,
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
        senderMembershipId,
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
            recipientType: role.recipientType as "signer" | "approver" | "cc" | "viewer" | "in_person_host" | "internal_reviewer",
            name: provided.name,
            email: provided.email,
            phone: provided.phone,
            routingOrder: role.routingOrder,
            authMethod: role.authMethod as "email_link" | "access_code" | "otp_email" | "otp_sms" | "sso" | "passkey" | "kba" | "id_verification",
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

  async publishPublicForm(orgId: string, createdByMembershipId: number | null, templateId: number, input: PublishPublicFormInput) {
    const template = await this.get(orgId, templateId);
    if (template.status !== "published") throw new ForbiddenException("Only published templates can be turned into a public form");

    const form = await this.insertPublicForm(orgId, createdByMembershipId, templateId, input);

    await this.audit.record({
      orgId,
      envelopeId: null,
      actorType: "internal_user",
      eventType: "public_form_published",
      eventMessage: `Published public form at /${input.slug}`,
    });

    return form;
  }

  /**
   * `uniq_sign_public_forms_slug` is a GLOBAL unique index, because the slug is a
   * public URL and the namespace is the platform's, not the tenant's. The
   * pre-flight `findFirst` cannot see another organisation's row — RLS on
   * `sign_public_forms` admits `org_id = current_org_id() OR slug =
   * current_public_token()`, and an authenticated request sets no public token —
   * so a slug taken by another tenant used to pass the check and then break the
   * index, and the 23505 escaped as a 500. The insert is the only authority, and
   * both cases now answer the same 409 so the reply cannot separate "yours" from
   * "someone else's".
   */
  private async insertPublicForm(
    orgId: string,
    createdByMembershipId: number | null,
    templateId: number,
    input: PublishPublicFormInput,
  ) {
    try {
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

  async getPublicForm(slug: string) {
    const form = await withPublicToken(this.db, slug, (tx) =>
      tx.query.signPublicForms.findFirst({ where: eq(signPublicForms.slug, slug) }),
    );
    if (!form || form.status !== "published") throw new NotFoundException("Form not found");
    if (form.expiresAt && form.expiresAt.getTime() < Date.now()) throw new NotFoundException("Form not found");
    if (form.maxSubmissions && form.submissionCount >= form.maxSubmissions) throw new NotFoundException("Form not found");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const template = await tx.query.signTemplates.findFirst({ where: eq(signTemplates.id, form.templateId) });
        return { form: { slug: form.slug, requiresAccessCode: Boolean(form.accessCodeHash), embedAllowed: form.embedAllowed }, template };
      },
      { orgId: form.orgId },
    );
  }
}
