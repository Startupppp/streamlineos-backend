import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { itemsPagedSchema, successSchema } from "../../../common/openapi/response-envelopes";

/**
 * Response schema file for the e-sign module.
 * Derived from service projections and Drizzle column types — not from
 * hand-written client interfaces. NOT `.strict()` (backward-compatible extra
 * fields are safe in responses).
 */

// ─── Shared envelope row ──────────────────────────────────────────────────────

export const signEnvelopeRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  subject: z.string().nullable(),
  message: z.string().nullable(),
  status: z.enum(["draft", "ready_to_send", "sent", "delivered", "partially_completed", "completed", "declined", "voided", "expired", "correction_required", "failed"]),
  routingMode: z.enum(["parallel", "sequential", "mixed"]),
  ccTiming: z.enum(["on_send", "on_complete"]),
  allowDecline: z.boolean(),
  sourceModule: z.string().nullable(),
  sourceEntityType: z.string().nullable(),
  sourceEntityId: z.string().nullable(),
  templateId: z.number().int().nullable(),
  watermarkPolicyId: z.number().int().nullable(),
  senderMembershipId: z.number().int().nullable(),
  reminderEnabled: z.boolean(),
  reminderFirstAfterDays: z.number().int(),
  reminderRepeatDays: z.number().int(),
  reminderMaxCount: z.number().int(),
  reminderSentCount: z.number().int(),
  lastReminderAt: nullableWireDate(),
  expiresAt: nullableWireDate(),
  sentAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  voidedAt: nullableWireDate(),
  voidedByMembershipId: z.number().int().nullable(),
  voidReason: z.string().nullable(),
  declinedAt: nullableWireDate(),
  correctionRequiredAt: nullableWireDate(),
  correctionReason: z.string().nullable(),
  finalizationKey: z.string().nullable(),
  finalizedAt: nullableWireDate(),
  finalPdfFileKey: z.string().nullable(),
  finalPdfHash: z.string().nullable(),
  publicFormId: z.number().int().nullable(),
  metadataJson: z.record(z.string(), z.unknown()),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

// ─── sign-envelopes.controller.ts ────────────────────────────────────────────

/** `create` / `update` / `send` / `voidEnvelope` / `correct` / `extendExpiration` — full row. */
export const envelopeMutationResponseSchema = signEnvelopeRowSchema;

/** `list` — `buildListResponse` → `{items, total, page, pageSize, totalPages}`. */
export const listEnvelopesResponseSchema = itemsPagedSchema(signEnvelopeRowSchema).extend({
  pageSize: z.number().int(),
});

/** `get` (getFull) — `{envelope, documents, recipients, fields}`. */
export const getEnvelopeFullResponseSchema = z.object({
  envelope: signEnvelopeRowSchema,
  documents: z.array(
    z.object({
      id: z.number().int(),
      orgId: z.string(),
      envelopeId: z.number().int(),
      originalFileKey: z.string(),
      currentFileKey: z.string(),
      fileName: z.string(),
      mimeType: z.string(),
      pageCount: z.number().int().nullable(),
      fileSize: z.number().int(),
      sha256Hash: z.string(),
      conversionStatus: z.enum(["pending", "converted", "failed", "not_needed"]),
      conversionError: z.string().nullable(),
      orderIndex: z.number().int(),
      createdByMembershipId: z.number().int().nullable(),
      createdAt: wireDate(),
      updatedAt: wireDate(),
    }),
  ),
  recipients: z.array(
    z.object({
      id: z.number().int(),
      orgId: z.string(),
      envelopeId: z.number().int(),
      roleName: z.string(),
      recipientType: z.enum(["signer", "approver", "cc", "viewer", "in_person_host", "internal_reviewer"]),
      name: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      userMembershipId: z.number().int().nullable(),
      routingOrder: z.number().int(),
      status: z.enum(["pending", "invited", "viewed", "authenticated", "signing", "completed", "declined", "delegated", "bounced", "expired"]),
      authMethod: z.enum(["email_link", "access_code", "otp_email", "otp_sms", "sso", "passkey", "kba", "id_verification"]),
      accessCodeHash: z.string().nullable(),
      otpCodeHash: z.string().nullable(),
      otpExpiresAt: nullableWireDate(),
      otpAttempts: z.number().int(),
      failedAuthAttempts: z.number().int(),
      authLockedUntil: nullableWireDate(),
      signingTokenHash: z.string().nullable(),
      tokenExpiresAt: nullableWireDate(),
      tokenRevokedAt: nullableWireDate(),
      consentAcceptedAt: nullableWireDate(),
      consentIp: z.string().nullable(),
      consentUserAgent: z.string().nullable(),
      consentDisclosureVersion: z.string().nullable(),
      delegatedToRecipientId: z.number().int().nullable(),
      viewedAt: nullableWireDate(),
      authenticatedAt: nullableWireDate(),
      completedAt: nullableWireDate(),
      declinedAt: nullableWireDate(),
      declinedReason: z.string().nullable(),
      bouncedAt: nullableWireDate(),
      createdAt: wireDate(),
      updatedAt: wireDate(),
    }),
  ),
  fields: z.array(
    z.object({
      id: z.number().int(),
      orgId: z.string(),
      envelopeId: z.number().int(),
      documentId: z.number().int(),
      recipientId: z.number().int(),
      fieldType: z.enum(["signature", "initials", "date_signed", "text", "multiline", "email", "name", "company", "title", "checkbox", "radio", "dropdown", "attachment", "stamp", "strikethrough", "readonly_merge"]),
      label: z.string().nullable(),
      pageNumber: z.number().int(),
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int(),
      height: z.number().int(),
      required: z.boolean(),
      readonly: z.boolean(),
      orderIndex: z.number().int(),
      groupId: z.string().nullable(),
      defaultValue: z.string().nullable(),
      optionsJson: z.array(z.string()).nullable(),
      validationType: z.string().nullable(),
      validationRulesJson: z.record(z.string(), z.unknown()).nullable(),
      conditionalRulesJson: z.record(z.string(), z.unknown()).nullable(),
      valueJson: z.record(z.string(), z.unknown()).nullable(),
      attachmentFileKey: z.string().nullable(),
      completedAt: nullableWireDate(),
      createdAt: wireDate(),
      updatedAt: wireDate(),
    }),
  ),
});

/** `validate` — `EnvelopeValidationResult`. */
export const validateEnvelopeResponseSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
});

/** `resend` — `{ resentCount: number }`. */
export const resendEnvelopeResponseSchema = z.object({ resentCount: z.number().int() });

/** `sendReminder` — `{ remindedCount: number }`. */
export const sendReminderResponseSchema = z.object({ remindedCount: z.number().int() });

// ─── sign-documents.controller.ts ────────────────────────────────────────────

const signDocumentRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  envelopeId: z.number().int(),
  originalFileKey: z.string(),
  currentFileKey: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  pageCount: z.number().int().nullable(),
  fileSize: z.number().int(),
  sha256Hash: z.string(),
  conversionStatus: z.enum(["pending", "converted", "failed", "not_needed"]),
  conversionError: z.string().nullable(),
  orderIndex: z.number().int(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `upload` — full `signDocuments` row. */
export const uploadDocumentResponseSchema = signDocumentRowSchema;

/** `list` — array of `signDocuments` rows. */
export const listDocumentsResponseSchema = z.array(signDocumentRowSchema);

/** `preview` — `{document, url, expiresInSeconds}`. */
export const previewDocumentResponseSchema = z.object({
  document: signDocumentRowSchema,
  url: z.string(),
  expiresInSeconds: z.number().int(),
});

// ─── sign-recipients.controller.ts ───────────────────────────────────────────

const signRecipientRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  envelopeId: z.number().int(),
  roleName: z.string(),
  recipientType: z.enum(["signer", "approver", "cc", "viewer", "in_person_host", "internal_reviewer"]),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  userMembershipId: z.number().int().nullable(),
  routingOrder: z.number().int(),
  status: z.enum(["pending", "invited", "viewed", "authenticated", "signing", "completed", "declined", "delegated", "bounced", "expired"]),
  authMethod: z.enum(["email_link", "access_code", "otp_email", "otp_sms", "sso", "passkey", "kba", "id_verification"]),
  accessCodeHash: z.string().nullable(),
  otpCodeHash: z.string().nullable(),
  otpExpiresAt: nullableWireDate(),
  otpAttempts: z.number().int(),
  failedAuthAttempts: z.number().int(),
  authLockedUntil: nullableWireDate(),
  signingTokenHash: z.string().nullable(),
  tokenExpiresAt: nullableWireDate(),
  tokenRevokedAt: nullableWireDate(),
  consentAcceptedAt: nullableWireDate(),
  consentIp: z.string().nullable(),
  consentUserAgent: z.string().nullable(),
  consentDisclosureVersion: z.string().nullable(),
  delegatedToRecipientId: z.number().int().nullable(),
  viewedAt: nullableWireDate(),
  authenticatedAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  declinedAt: nullableWireDate(),
  declinedReason: z.string().nullable(),
  bouncedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `add` / `update` — full `signRecipients` row. */
export const recipientMutationResponseSchema = signRecipientRowSchema;

/** `list` — array of `signRecipients` rows. */
export const listRecipientsResponseSchema = z.array(signRecipientRowSchema);

// ─── sign-fields.controller.ts ───────────────────────────────────────────────

const signFieldRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  envelopeId: z.number().int(),
  documentId: z.number().int(),
  recipientId: z.number().int(),
  fieldType: z.enum(["signature", "initials", "date_signed", "text", "multiline", "email", "name", "company", "title", "checkbox", "radio", "dropdown", "attachment", "stamp", "strikethrough", "readonly_merge"]),
  label: z.string().nullable(),
  pageNumber: z.number().int(),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  required: z.boolean(),
  readonly: z.boolean(),
  orderIndex: z.number().int(),
  groupId: z.string().nullable(),
  defaultValue: z.string().nullable(),
  optionsJson: z.array(z.string()).nullable(),
  validationType: z.string().nullable(),
  validationRulesJson: z.record(z.string(), z.unknown()).nullable(),
  conditionalRulesJson: z.record(z.string(), z.unknown()).nullable(),
  valueJson: z.record(z.string(), z.unknown()).nullable(),
  attachmentFileKey: z.string().nullable(),
  completedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `add` / `update` — full `signFields` row. */
export const fieldMutationResponseSchema = signFieldRowSchema;

/** `list` — array of `signFields` rows. */
export const listFieldsResponseSchema = z.array(signFieldRowSchema);

// ─── sign-templates.controller.ts ────────────────────────────────────────────

const signTemplateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  status: z.enum(["draft", "published", "archived"]),
  ownerMembershipId: z.number().int().nullable(),
  version: z.number().int(),
  templateJson: z.record(z.string(), z.unknown()),
  restrictedToRoles: z.array(z.string()),
  restrictedToTeams: z.array(z.string()),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `create` / `createFromEnvelope` / `update` / `duplicate` — full `signTemplates` row. */
export const templateMutationResponseSchema = signTemplateRowSchema;

/** `list` — array of `signTemplates` rows. */
export const listTemplatesResponseSchema = z.array(signTemplateRowSchema);

/** `instantiate` — the created `signEnvelopes` row. */
export const instantiateTemplateResponseSchema = signEnvelopeRowSchema;

const signPublicFormRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  templateId: z.number().int(),
  slug: z.string(),
  accessCodeHash: z.string().nullable(),
  maxSubmissions: z.number().int().nullable(),
  submissionCount: z.number().int(),
  expiresAt: nullableWireDate(),
  completionRedirectUrl: z.string().nullable(),
  webhookUrl: z.string().nullable(),
  embedAllowed: z.boolean(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `publishPublicForm` — the created `signPublicForms` row. */
export const publishPublicFormResponseSchema = signPublicFormRowSchema;

// ─── sign-bulk-send.controller.ts ────────────────────────────────────────────

const signBulkSendJobRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  templateId: z.number().int(),
  senderMembershipId: z.number().int().nullable(),
  status: z.enum(["pending", "validating", "running", "completed", "failed", "cancelled"]),
  columnMappingJson: z.record(z.string(), z.string()),
  totalCount: z.number().int(),
  successCount: z.number().int(),
  failedCount: z.number().int(),
  csvFileKey: z.string().nullable(),
  errorReportFileKey: z.string().nullable(),
  createdAt: wireDate(),
  completedAt: nullableWireDate(),
});

const signBulkSendRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  jobId: z.number().int(),
  rowNumber: z.number().int(),
  rawDataJson: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "success", "failed"]),
  envelopeId: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `createJob` — `{job, dryRun}` with optional preview. */
export const createBulkJobResponseSchema = z.object({
  job: signBulkSendJobRowSchema,
  dryRun: z.boolean(),
  preview: z.unknown().optional(),
});

/** `listJobs` — array of `signBulkSendJobs` rows. */
export const listBulkJobsResponseSchema = z.array(signBulkSendJobRowSchema);

/** `getJob` — `{job, rows}`. */
export const getBulkJobResponseSchema = z.object({
  job: signBulkSendJobRowSchema,
  rows: z.array(signBulkSendRowSchema),
});

/** `cancel` — full `signBulkSendJobs` row. */
export const cancelBulkJobResponseSchema = signBulkSendJobRowSchema;

/** `getErrorReport` — failed rows. */
export const bulkJobErrorReportResponseSchema = z.array(signBulkSendRowSchema);

// ─── sign-public.controller.ts ───────────────────────────────────────────────

const signFieldRowForPublicSchema = signFieldRowSchema;

/** `getSession` — discriminated on `state`. */
export const getSessionResponseSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("active"),
    envelope: z.object({
      id: z.number().int(),
      title: z.string(),
      subject: z.string().nullable(),
      message: z.string().nullable(),
      expiresAt: nullableWireDate(),
    }),
    sender: z.object({ name: z.string() }),
    recipient: z.object({
      id: z.number().int(),
      name: z.string(),
      email: z.string().nullable(),
      authMethod: z.string(),
      authenticated: z.boolean(),
      consentAccepted: z.boolean(),
    }),
    documents: z.array(
      z.object({ id: z.number().int(), fileName: z.string(), pageCount: z.number().int().nullable() }),
    ),
    fields: z.array(signFieldRowForPublicSchema),
  }),
  z.object({
    state: z.string().refine((s) => s !== "active"),
    envelopeTitle: z.string(),
    recipientName: z.string(),
  }),
]);

/** `getDocumentPreview` — `{url, expiresInSeconds}`. */
export const getPublicDocumentPreviewResponseSchema = z.object({
  url: z.string(),
  expiresInSeconds: z.number().int(),
});

/** `requestOtp` — `{sent: true}`. */
export const requestOtpResponseSchema = z.object({ sent: z.literal(true) });

/** `authenticate` — `{authenticated: true}`. */
export const authenticateResponseSchema = z.object({ authenticated: z.literal(true) });

/** `consent` — `{accepted: true}`. */
export const consentResponseSchema = z.object({ accepted: z.literal(true) });

/** `setFieldValue` — `{success: true}`. */
export const setFieldValueResponseSchema = z.object({ success: z.literal(true) });

const signatureAssetRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  envelopeId: z.number().int(),
  recipientId: z.number().int(),
  assetType: z.enum(["signature", "initials", "stamp"]),
  method: z.enum(["drawn", "typed", "uploaded", "saved"]),
  imageFileKey: z.string().nullable(),
  typedText: z.string().nullable(),
  typedFontStyle: z.string().nullable(),
  createdAt: wireDate(),
});

/** `adoptSignature` — the created `signSignatureAssets` row. */
export const adoptSignatureResponseSchema = signatureAssetRowSchema;

/** `complete` — `{completed: true, envelopeCompleted: boolean}`. */
export const completeSigningResponseSchema = z.object({
  completed: z.literal(true),
  envelopeCompleted: z.boolean(),
});

/** `decline` — `{declined: true}`. */
export const declineSigningResponseSchema = z.object({ declined: z.literal(true) });

/** `getPublicForm` — `{form, template}`. */
export const getPublicFormResponseSchema = z.object({
  form: z.object({
    slug: z.string(),
    requiresAccessCode: z.boolean(),
    embedAllowed: z.boolean(),
  }),
  template: signTemplateRowSchema,
});

/** `submitPublicForm` — `{token, recipientId, envelopeId, redirectUrl}`. */
export const submitPublicFormResponseSchema = z.object({
  token: z.string(),
  recipientId: z.number().int(),
  envelopeId: z.number().int(),
  redirectUrl: z.string().nullable(),
});

// ─── sign-admin.controller.ts ────────────────────────────────────────────────

/** `signOrgSettings` minus `webhookSecret`. */
export const signSettingsResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  defaultExpirationDays: z.number().int(),
  expirationWarningDays: z.number().int(),
  defaultReminderFirstAfterDays: z.number().int(),
  defaultReminderRepeatDays: z.number().int(),
  defaultReminderMaxCount: z.number().int(),
  allowedFileTypes: z.array(z.string()),
  maxFileSizeMb: z.number().int(),
  allowedAuthMethods: z.array(z.string()),
  certificateFormat: z.string(),
  retentionPolicyJson: z.record(z.string(), z.unknown()),
  publicFormsEnabled: z.boolean(),
  bulkSendMaxRowsPerJob: z.number().int(),
  bulkSendMaxActiveJobs: z.number().int(),
  bulkSendMaxRecipientsPerEnvelope: z.number().int(),
  senderRateLimitPerHour: z.number().int(),
  brandingJson: z.record(z.string(), z.unknown()).nullable(),
  webhookUrl: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const signWatermarkPolicyRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  scopeType: z.string(),
  scopeId: z.number().int().nullable(),
  text: z.string().nullable(),
  imageFileKey: z.string().nullable(),
  opacity: z.number().int(),
  angle: z.number().int(),
  color: z.string(),
  fontSize: z.number().int(),
  placement: z.string(),
  showOnFinalPdf: z.boolean(),
  previewOnly: z.boolean(),
  enabled: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `listWatermarkPolicies` — array of watermark rows. */
export const listWatermarkPoliciesResponseSchema = z.array(signWatermarkPolicyRowSchema);

/** `getWatermarkPolicy` / `createWatermarkPolicy` / `updateWatermarkPolicy` — single row. */
export const watermarkPolicyMutationResponseSchema = signWatermarkPolicyRowSchema;

/** `runReminderSweep` — `{remindedCount}`. */
export const reminderSweepResponseSchema = z.object({ remindedCount: z.number().int() });

/** `runExpirationSweep` — `{expiredCount}`. */
export const expirationSweepResponseSchema = z.object({ expiredCount: z.number().int() });

// ─── sign-ai.controller.ts ───────────────────────────────────────────────────

/** `summarize` — `{summary: string}`. */
export const signAiSummarizeResponseSchema = z.object({ summary: z.string() });

// ─── sign-reports.controller.ts ──────────────────────────────────────────────

const signAuditEventSummarySchema = z.object({
  id: z.number().int(),
  envelopeId: z.number().int().nullable(),
  recipientId: z.number().int().nullable(),
  actorType: z.string(),
  actorName: z.string().nullable(),
  actorEmail: z.string().nullable(),
  eventType: z.string(),
  eventMessage: z.string().nullable(),
  createdAt: wireDate(),
});

/** `getDashboard` — summary metrics + recent activity. */
export const signDashboardResponseSchema = z.object({
  awaitingMe: z.number().int(),
  sentPending: z.number().int(),
  completedThisMonth: z.number().int(),
  expiringSoon: z.number().int(),
  failedOrBounced: z.number().int(),
  recentActivity: z.array(signAuditEventSummarySchema),
});

/** `getSummary` — aggregated org stats. */
export const signSummaryResponseSchema = z.object({
  byStatus: z.record(z.string(), z.number().int()),
  avgTimeToSignHours: z.number().nullable(),
  completionRate: z.number(),
  declineRate: z.number(),
  expiringSoonCount: z.number().int(),
  senderPerformance: z.array(
    z.object({
      senderMembershipId: z.number().int().nullable(),
      senderName: z.string().nullable(),
      sentCount: z.number().int(),
    }),
  ),
  templateUsage: z.array(
    z.object({
      templateId: z.number().int().nullable(),
      templateName: z.string(),
      value: z.number().int(),
    }),
  ),
  bulkSendStats: z.object({
    totalJobs: z.number().int(),
    totalRows: z.number(),
    successRows: z.number(),
    failedRows: z.number(),
  }).nullable(),
  authFailures: z.number().int(),
  watermarkUsageCount: z.number().int(),
});

// ─── sign-certificates.controller.ts ─────────────────────────────────────────

const signCertificateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  envelopeId: z.number().int(),
  certificateNumber: z.string(),
  certificateFileKey: z.string(),
  finalPdfFileKey: z.string(),
  finalPdfHash: z.string(),
  watermarked: z.boolean(),
  generatedAt: wireDate(),
  certificateJson: z.record(z.string(), z.unknown()),
});

const signAuditEventFullSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  envelopeId: z.number().int().nullable(),
  recipientId: z.number().int().nullable(),
  actorType: z.string(),
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  actorEmail: z.string().nullable(),
  eventType: z.string(),
  eventMessage: z.string().nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  geolocationJson: z.record(z.string(), z.unknown()).nullable(),
  documentHash: z.string().nullable(),
  requestId: z.string().nullable(),
  eventPayloadJson: z.record(z.string(), z.unknown()).nullable(),
  createdAt: wireDate(),
});

/** `getAudit` — `listForEnvelope` → full `signAuditEvents` rows. */
export const listAuditEventsResponseSchema = z.array(signAuditEventFullSchema);

/** `getCertificate` — `{url, expiresInSeconds, certificate}`. */
export const getCertificateUrlResponseSchema = z.object({
  url: z.string(),
  expiresInSeconds: z.number().int(),
  certificate: signCertificateRowSchema,
});

/** `getFinalPdf` — `{url, expiresInSeconds, hash}`. */
export const getFinalPdfUrlResponseSchema = z.object({
  url: z.string(),
  expiresInSeconds: z.number().int(),
  hash: z.string().nullable(),
});

/** `regenerateCertificate` — full `signCertificates` row. */
export const regenerateCertificateResponseSchema = signCertificateRowSchema;

export { successSchema };
