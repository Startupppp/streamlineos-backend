import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

const publicCredentialSchema = z.object({
  environment: z.enum(["test", "live"]),
  maskedKeyHint: z.string().nullable(),
  hasSecret: z.boolean(),
  hasWebhookSecret: z.boolean(),
  lastRotatedAt: nullableWireDate(),
});

export const paymentProviderRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  providerKey: z.string(),
  displayName: z.string(),
  status: z.string(),
  environment: z.string(),
  isPrimary: z.boolean(),
  supportedCurrencies: z.array(z.string()),
  supportedPaymentMethods: z.array(z.string()),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const paymentProviderWithCredentialsSchema = paymentProviderRowSchema.extend({
  credentials: z.array(publicCredentialSchema),
});

export const paymentProviderListResponseSchema = z.array(paymentProviderWithCredentialsSchema);

const catalogEntrySchema = z.object({
  key: z.string(),
  displayName: z.string(),
  supportedCountries: z.array(z.string()),
  supportedCurrencies: z.array(z.string()),
  supportedPaymentMethods: z.array(z.string()),
  useCases: z.array(z.string()),
  credentialFields: z.array(z.string()),
  isImplemented: z.boolean(),
  expectedWebhookEvents: z.array(z.string()),
});

export const paymentProviderCatalogResponseSchema = z.array(catalogEntrySchema);

export const credentialSaveResponseSchema = z.object({
  credential: publicCredentialSchema,
  warning: z.string().optional(),
});

export const paymentTestTransactionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  providerId: z.number().int(),
  environment: z.string(),
  amount: z.string(),
  currency: z.string(),
  status: z.string(),
  providerOrderId: z.string().nullable(),
  providerPaymentId: z.string().nullable(),
  signatureVerified: z.boolean(),
  webhookReceived: z.boolean(),
  resultSummary: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const paymentTestTransactionListSchema = z.array(paymentTestTransactionRowSchema);

const webhookEndpointRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  providerId: z.number().int(),
  environment: z.string(),
  url: z.string(),
  expectedEvents: z.array(z.string()),
  status: z.string(),
  lastVerifiedAt: nullableWireDate(),
  lastFailureAt: nullableWireDate(),
  failureReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const webhookEndpointResponseSchema = webhookEndpointRowSchema;

const webhookEventRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  providerId: z.number().int(),
  environment: z.string(),
  providerEventId: z.string(),
  eventType: z.string(),
  signatureValid: z.boolean(),
  processingStatus: z.string(),
  idempotencyKey: z.string(),
  relatedInvoiceId: z.number().int().nullable(),
  relatedSubscriptionId: z.string().nullable(),
  payloadRedacted: z.record(z.string(), z.unknown()),
  receivedAt: wireDate(),
  processedAt: nullableWireDate(),
  errorMessage: z.string().nullable(),
});

export const webhookEventListResponseSchema = z.array(webhookEventRowSchema);
export const webhookEventRowResponseSchema = webhookEventRowSchema;

export const paymentReadinessResponseSchema = z.object({
  completedChecks: z.array(z.string()),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  readyForLive: z.boolean(),
});

const paymentAuditEventRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  actorUserId: z.string().nullable(),
  providerId: z.number().int().nullable(),
  action: z.string(),
  environment: z.string().nullable(),
  beforeRedacted: z.record(z.string(), z.unknown()).nullable(),
  afterRedacted: z.record(z.string(), z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: wireDate(),
});

export const paymentAuditListResponseSchema = z.array(paymentAuditEventRowSchema);

const paymentManualMethodRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  methodType: z.string(),
  displayName: z.string(),
  instructions: z.string().nullable(),
  bankName: z.string().nullable(),
  accountHolder: z.string().nullable(),
  maskedAccountNumber: z.string().nullable(),
  ifscSwiftIban: z.string().nullable(),
  upiId: z.string().nullable(),
  paymentReferenceInstructions: z.string().nullable(),
  requireManualApproval: z.boolean(),
  status: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const paymentManualMethodListResponseSchema = z.array(paymentManualMethodRowSchema);
export const paymentManualMethodRowResponseSchema = paymentManualMethodRowSchema;

export { successSchema };
