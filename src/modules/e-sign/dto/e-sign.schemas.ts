import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

export const signFieldTypeSchema = z.enum([
  "signature",
  "initials",
  "date_signed",
  "text",
  "multiline",
  "email",
  "name",
  "company",
  "title",
  "checkbox",
  "radio",
  "dropdown",
  "attachment",
  "stamp",
  "strikethrough",
  "readonly_merge",
]);

export const signRecipientTypeSchema = z.enum([
  "signer",
  "approver",
  "cc",
  "viewer",
  "in_person_host",
  "internal_reviewer",
]);

export const signAuthMethodSchema = z.enum([
  "email_link",
  "access_code",
  "otp_email",
  "otp_sms",
  "sso",
  "passkey",
  "kba",
  "id_verification",
]);

export const signRoutingModeSchema = z.enum(["parallel", "sequential", "mixed"]);
export const signCcTimingSchema = z.enum(["on_send", "on_complete"]);

// ---- Envelopes ----

export const createEnvelopeSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  subject: z.string().trim().max(200).optional(),
  message: z.string().trim().max(5000).optional(),
  routingMode: signRoutingModeSchema.default("parallel"),
  ccTiming: signCcTimingSchema.default("on_complete"),
  allowDecline: z.boolean().default(true),
  sourceModule: z.string().trim().max(50).optional(),
  sourceEntityType: z.string().trim().max(50).optional(),
  sourceEntityId: z.string().trim().max(100).optional(),
  templateId: z.number().int().positive().optional(),
  watermarkPolicyId: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  reminderEnabled: z.boolean().default(true),
  reminderFirstAfterDays: z.number().int().min(1).max(90).default(3),
  reminderRepeatDays: z.number().int().min(1).max(90).default(3),
  reminderMaxCount: z.number().int().min(0).max(20).default(5),
  metadataJson: z.record(z.string(), z.unknown()).optional(),
});
export type CreateEnvelopeInput = z.infer<typeof createEnvelopeSchema>;

export const updateEnvelopeSchema = createEnvelopeSchema.partial();
export type UpdateEnvelopeInput = z.infer<typeof updateEnvelopeSchema>;

export const listEnvelopesSchema = z.object({
  status: z.string().trim().optional(),
  sourceModule: z.string().trim().optional(),
  sourceEntityType: z.string().trim().optional(),
  sourceEntityId: z.string().trim().optional(),
  page: pageNumberField,
  limit: pageSizeField(25, 100),
});
export type ListEnvelopesInput = z.infer<typeof listEnvelopesSchema>;

export const voidEnvelopeSchema = z.object({
  reason: z.string().trim().min(1, "Void reason is required").max(1000),
});
export type VoidEnvelopeInput = z.infer<typeof voidEnvelopeSchema>;

export const correctEnvelopeSchema = z.object({
  reason: z.string().trim().min(1).max(1000).optional(),
  recipients: z
    .array(
      z.object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1).max(200).optional(),
        email: z.string().trim().email().optional(),
        phone: z.string().trim().max(30).optional(),
      }),
    )
    .max(50)
    .optional(),
});
export type CorrectEnvelopeInput = z.infer<typeof correctEnvelopeSchema>;

export const extendExpirationSchema = z.object({
  expiresAt: z.string().datetime(),
});
export type ExtendExpirationInput = z.infer<typeof extendExpirationSchema>;

// ---- Documents ----

export const uploadDocumentMetaSchema = z.object({
  orderIndex: z.coerce.number().int().min(0).default(0),
});
export type UploadDocumentMetaInput = z.infer<typeof uploadDocumentMetaSchema>;

// ---- Recipients ----

const PERSON_NAME_REGEX = /^[A-Za-z][A-Za-z\s'.-]{1,79}$/;

export const createRecipientSchema = z.object({
  roleName: z
    .string()
    .trim()
    .min(1, "Role is required")
    .max(100)
    .refine((v) => /[a-zA-Z0-9]/.test(v), "Role must contain at least one letter or number")
    .refine((v) => !/^[\W_]+$/.test(v), "Role cannot consist of only special characters")
    .refine((v) => !/\s{2,}/.test(v), "Role cannot have multiple consecutive spaces"),
  recipientType: signRecipientTypeSchema.default("signer"),
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(80, "Name must be at most 80 characters")
    .regex(PERSON_NAME_REGEX, "Enter a valid name (letters, spaces, and ' . - only)"),
  email: z.string().trim().email("Valid email is required").optional(),
  phone: z.string().trim().max(30).optional(),
  userMembershipId: z.number().int().optional(),
  routingOrder: z.number().int().min(1).max(50).default(1),
  authMethod: signAuthMethodSchema.default("email_link"),
  accessCode: z.string().trim().min(4).max(50).optional(),
});
export type CreateRecipientInput = z.infer<typeof createRecipientSchema>;

export const updateRecipientSchema = createRecipientSchema.partial();
export type UpdateRecipientInput = z.infer<typeof updateRecipientSchema>;

// ---- Fields ----

export const createFieldSchema = z.object({
  documentId: z.number().int().positive(),
  recipientId: z.number().int().positive(),
  fieldType: signFieldTypeSchema,
  label: z.string().trim().max(200).optional(),
  pageNumber: z.number().int().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  required: z.boolean().default(false),
  readonly: z.boolean().default(false),
  orderIndex: z.number().int().min(0).default(0),
  groupId: z.string().trim().max(100).optional(),
  defaultValue: z.string().trim().max(2000).optional(),
  optionsJson: z.array(z.string().trim().max(200)).max(50).optional(),
  validationType: z.string().trim().max(50).optional(),
  validationRulesJson: z.record(z.string(), z.unknown()).optional(),
  conditionalRulesJson: z.record(z.string(), z.unknown()).optional(),
});
export type CreateFieldInput = z.infer<typeof createFieldSchema>;

export const updateFieldSchema = createFieldSchema.partial().omit({ documentId: true, recipientId: true });
export type UpdateFieldInput = z.infer<typeof updateFieldSchema>;

// ---- Templates ----

export const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().max(100).optional(),
  templateJson: z.record(z.string(), z.unknown()).default({}),
  restrictedToRoles: z.array(z.string().trim().max(100)).max(50).default([]),
  restrictedToTeams: z.array(z.string().trim().max(100)).max(50).default([]),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = createTemplateSchema.partial().extend({
  status: z.enum(["draft", "published", "archived"]).optional(),
});
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

export const saveAsTemplateSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();
export type SaveAsTemplateInput = z.infer<typeof saveAsTemplateSchema>;

export const createEnvelopeFromTemplateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  recipients: z
    .array(
      z.object({
        roleName: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(200),
        email: z.string().trim().email().optional(),
        phone: z.string().trim().max(30).optional(),
      }),
    )
    .min(1, "At least one recipient is required"),
  sourceModule: z.string().trim().max(50).optional(),
  sourceEntityType: z.string().trim().max(50).optional(),
  sourceEntityId: z.string().trim().max(100).optional(),
});
export type CreateEnvelopeFromTemplateInput = z.infer<typeof createEnvelopeFromTemplateSchema>;

export const publishPublicFormSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens"),
  accessCode: z.string().trim().min(4).max(50).optional(),
  maxSubmissions: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  completionRedirectUrl: z.string().trim().url().optional(),
  webhookUrl: z.string().trim().url().optional(),
  embedAllowed: z.boolean().default(false),
});
export type PublishPublicFormInput = z.infer<typeof publishPublicFormSchema>;

// ---- Bulk send ----

export const createBulkSendJobSchema = z.object({
  templateId: z.number().int().positive(),
  columnMapping: z.record(z.string(), z.string()),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
  dryRun: z.boolean().default(false),
});
export type CreateBulkSendJobInput = z.infer<typeof createBulkSendJobSchema>;

// ---- Public signing ----

export const publicAuthSchema = z.object({
  accessCode: z.string().trim().max(50).optional(),
  otpCode: z.string().trim().max(10).optional(),
});
export type PublicAuthInput = z.infer<typeof publicAuthSchema>;

export const publicConsentSchema = z.object({
  disclosureVersion: z.string().trim().min(1).max(50),
});
export type PublicConsentInput = z.infer<typeof publicConsentSchema>;

export const publicFieldValueSchema = z.object({
  value: z.union([z.string().max(5000), z.boolean(), z.null()]),
});
export type PublicFieldValueInput = z.infer<typeof publicFieldValueSchema>;

export const adoptSignatureSchema = z.object({
  assetType: z.enum(["signature", "initials", "stamp"]),
  method: z.enum(["drawn", "typed", "uploaded", "saved"]),
  imageDataUrl: z.string().trim().max(2_000_000).optional(),
  typedText: z.string().trim().max(200).optional(),
  typedFontStyle: z.string().trim().max(100).optional(),
});
export type AdoptSignatureInput = z.infer<typeof adoptSignatureSchema>;

export const declineSchema = z.object({
  reason: z.string().trim().min(1, "Decline reason is required").max(1000),
});
export type DeclineInput = z.infer<typeof declineSchema>;

export const publicFormSubmitSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  phone: z.string().trim().max(30).optional(),
  accessCode: z.string().trim().max(50).optional(),
});
export type PublicFormESignSubmitInput = z.infer<typeof publicFormSubmitSchema>;

// ---- Settings ----

export const updateSignSettingsSchema = z.object({
  defaultExpirationDays: z.number().int().min(1).max(365).optional(),
  expirationWarningDays: z.number().int().min(0).max(60).optional(),
  defaultReminderFirstAfterDays: z.number().int().min(1).max(90).optional(),
  defaultReminderRepeatDays: z.number().int().min(1).max(90).optional(),
  defaultReminderMaxCount: z.number().int().min(0).max(20).optional(),
  allowedFileTypes: z.array(z.string()).optional(),
  maxFileSizeMb: z.number().int().min(1).max(200).optional(),
  allowedAuthMethods: z.array(signAuthMethodSchema).optional(),
  certificateFormat: z.string().trim().max(20).optional(),
  publicFormsEnabled: z.boolean().optional(),
  bulkSendMaxRowsPerJob: z.number().int().min(1).max(10000).optional(),
  bulkSendMaxActiveJobs: z.number().int().min(1).max(100).optional(),
  bulkSendMaxRecipientsPerEnvelope: z.number().int().min(1).max(500).optional(),
  senderRateLimitPerHour: z.number().int().min(1).max(10000).optional(),
  brandingJson: z
    .object({
      logoUrl: z.string().trim().url().optional(),
      emailSenderName: z.string().trim().max(150).optional(),
      emailAccentColor: z.string().trim().max(20).optional(),
      signingPageLogoUrl: z.string().trim().url().optional(),
      signingPageSupportText: z.string().trim().max(1000).optional(),
      completionMessage: z.string().trim().max(1000).optional(),
      disclosureText: z.string().trim().max(5000).optional(),
      disclosureVersion: z.string().trim().max(50).optional(),
    })
    .partial()
    .optional(),
  webhookUrl: z.string().trim().url().optional(),
});
export type UpdateSignSettingsInput = z.infer<typeof updateSignSettingsSchema>;

export const watermarkPolicyInputSchema = z.object({
  scopeType: z.enum(["tenant", "template", "envelope"]),
  scopeId: z.number().int().positive().optional(),
  appliesStates: z.array(z.string()).default([]),
  text: z.string().trim().max(200).optional(),
  opacity: z.number().int().min(0).max(100).default(30),
  angle: z.number().int().min(-180).max(180).default(45),
  color: z.string().trim().max(20).default("#94A3B8"),
  fontSize: z.number().int().min(6).max(200).default(36),
  placement: z.string().trim().max(50).default("diagonal_tiled"),
  pages: z
    .object({ mode: z.enum(["all", "first", "custom"]), pageNumbers: z.array(z.number().int().min(1)).optional() })
    .default({ mode: "all" }),
  showOnFinalPdf: z.boolean().default(true),
  previewOnly: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type WatermarkPolicyInput = z.infer<typeof watermarkPolicyInputSchema>;
