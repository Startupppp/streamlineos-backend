import type { signDocuments, signEnvelopes, signFields, signRecipients } from "../../db/schema";

type SignEnvelopeRow = typeof signEnvelopes.$inferSelect;
type SignDocumentRow = typeof signDocuments.$inferSelect;
type SignRecipientRow = typeof signRecipients.$inferSelect;
type SignFieldRow = typeof signFields.$inferSelect;

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

export interface TemplateSnapshotSource {
  envelope: SignEnvelopeRow;
  documents: SignDocumentRow[];
  recipients: SignRecipientRow[];
  fields: SignFieldRow[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const text = (value: unknown, fallback: string): string => String(value ?? fallback);
const optionalText = (value: unknown): string | undefined => (value != null ? String(value) : undefined);
const nullableText = (value: unknown): string | null => (value != null ? String(value) : null);
const num = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);
const nullableNum = (value: unknown): number | null => (typeof value === "number" ? value : null);

function parseRole(value: unknown): TemplateRole {
  const role = asRecord(value);
  return {
    roleName: text(role["roleName"], ""),
    recipientType: text(role["recipientType"], "signer"),
    routingOrder: num(role["routingOrder"], 0),
    authMethod: text(role["authMethod"], "email_link"),
  };
}

function parseDocument(value: unknown): TemplateDocument {
  const document = asRecord(value);
  return {
    fileKey: text(document["fileKey"], ""),
    fileName: text(document["fileName"], ""),
    mimeType: text(document["mimeType"], ""),
    pageCount: nullableNum(document["pageCount"]),
    fileSize: num(document["fileSize"], 0),
    sha256Hash: text(document["sha256Hash"], ""),
    orderIndex: num(document["orderIndex"], 0),
  };
}

function parseField(value: unknown): TemplateField {
  const field = asRecord(value);
  const options = field["optionsJson"];
  const validationRules = field["validationRulesJson"];
  const conditionalRules = field["conditionalRulesJson"];
  return {
    roleName: text(field["roleName"], ""),
    documentIndex: num(field["documentIndex"], 0),
    fieldType: text(field["fieldType"], ""),
    label: nullableText(field["label"]),
    pageNumber: num(field["pageNumber"], 1),
    x: num(field["x"], 0),
    y: num(field["y"], 0),
    width: num(field["width"], 0),
    height: num(field["height"], 0),
    required: Boolean(field["required"]),
    readonly: Boolean(field["readonly"]),
    orderIndex: num(field["orderIndex"], 0),
    groupId: nullableText(field["groupId"]),
    defaultValue: nullableText(field["defaultValue"]),
    optionsJson: Array.isArray(options) ? options.map(String) : null,
    validationType: nullableText(field["validationType"]),
    validationRulesJson: isRecord(validationRules) ? validationRules : null,
    conditionalRulesJson: isRecord(conditionalRules) ? conditionalRules : null,
  };
}

/** Decodes a stored `sign_templates.template_json` blob into the snapshot every consumer reads. */
export function parseTemplateSnapshot(json: Record<string, unknown>): TemplateSnapshot {
  return {
    subject: optionalText(json["subject"]),
    message: optionalText(json["message"]),
    routingMode: text(json["routingMode"], "parallel"),
    ccTiming: text(json["ccTiming"], "on_complete"),
    allowDecline: Boolean(json["allowDecline"]),
    expirationDays: num(json["expirationDays"], 30),
    reminderEnabled: Boolean(json["reminderEnabled"]),
    reminderFirstAfterDays: num(json["reminderFirstAfterDays"], 3),
    reminderRepeatDays: num(json["reminderRepeatDays"], 2),
    reminderMaxCount: num(json["reminderMaxCount"], 3),
    watermarkPolicyId: nullableNum(json["watermarkPolicyId"]),
    roles: Array.isArray(json["roles"]) ? json["roles"].map(parseRole) : [],
    documents: Array.isArray(json["documents"]) ? json["documents"].map(parseDocument) : [],
    fields: Array.isArray(json["fields"]) ? json["fields"].map(parseField) : [],
  };
}

/** Encodes an envelope's documents, recipients-as-roles and fields into a reusable snapshot. */
export function buildTemplateSnapshot({ envelope, documents, recipients, fields }: TemplateSnapshotSource): TemplateSnapshot {
  const documentIndexById = new Map(documents.map((document, index) => [document.id, index]));
  const recipientRoleById = new Map(recipients.map((recipient) => [recipient.id, recipient.roleName]));

  return {
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
    roles: recipients.map((recipient) => ({
      roleName: recipient.roleName,
      recipientType: recipient.recipientType,
      routingOrder: recipient.routingOrder,
      authMethod: recipient.authMethod,
    })),
    documents: documents.map((document) => ({
      fileKey: document.currentFileKey,
      fileName: document.fileName,
      mimeType: document.mimeType,
      pageCount: document.pageCount,
      fileSize: document.fileSize,
      sha256Hash: document.sha256Hash,
      orderIndex: document.orderIndex,
    })),
    fields: fields.map((field) => ({
      roleName: recipientRoleById.get(field.recipientId) ?? "",
      documentIndex: documentIndexById.get(field.documentId) ?? 0,
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
    })),
  };
}
