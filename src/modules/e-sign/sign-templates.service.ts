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
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { SignAuditService } from "./sign-audit.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignAuthMethodPolicy } from "./sign-auth-method.policy";
import { SignTokensService } from "./sign-tokens.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import type {
  CreateTemplateInput,
  UpdateTemplateInput,
  CreateEnvelopeFromTemplateInput,
} from "./dto/e-sign.schemas";
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
  /**
   * Optional on purpose. The parser used to substitute 3/2/3 here — a third
   * hardcoded cadence, agreeing with neither the column defaults (3/3/5) nor
   * the DTO's, and unreachable by any org setting. Absence now means "use the
   * organisation's default", resolved at instantiation.
   */
  reminderFirstAfterDays?: number;
  reminderRepeatDays?: number;
  reminderMaxCount?: number;
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
    reminderFirstAfterDays: typeof json["reminderFirstAfterDays"] === "number" ? json["reminderFirstAfterDays"] : undefined,
    reminderRepeatDays: typeof json["reminderRepeatDays"] === "number" ? json["reminderRepeatDays"] : undefined,
    reminderMaxCount: typeof json["reminderMaxCount"] === "number" ? json["reminderMaxCount"] : undefined,
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
    private readonly settings: SignSettingsService,
    private readonly authMethods: SignAuthMethodPolicy,
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

    const templateJson: Record<string, unknown> = { ...snapshot };
    return this.create(orgId, userId, { name, templateJson, restrictedToRoles: [], restrictedToTeams: [] });
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
        ownerUserId: actor.userId,
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
  async instantiate(orgId: string, userId: string, templateId: number, input: CreateEnvelopeFromTemplateInput) {
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
        reminderFirstAfterDays:
          snapshot.reminderFirstAfterDays ?? orgSettings.defaultReminderFirstAfterDays,
        reminderRepeatDays: snapshot.reminderRepeatDays ?? orgSettings.defaultReminderRepeatDays,
        reminderMaxCount: snapshot.reminderMaxCount ?? orgSettings.defaultReminderMaxCount,
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
}
