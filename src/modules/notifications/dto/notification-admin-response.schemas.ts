import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

export const notificationEventDefinitionSchema = z.object({
  eventKey: z.string(),
  displayName: z.string(),
  description: z.string(),
  category: z.string(),
  sourceModule: z.string().nullable(),
  defaultPriority: z.string(),
  defaultChannels: z.array(z.string()),
  allowedChannels: z.array(z.string()),
  mandatory: z.boolean(),
  userConfigurable: z.boolean(),
  enabled: z.boolean(),
  overridden: z.boolean().optional(),
});

export const notificationEventsListSchema = z.array(notificationEventDefinitionSchema);

export const notificationEventUpdateSchema = notificationEventDefinitionSchema.omit({ overridden: true });

const notificationDispatchResultSchema = z.object({
  chunkInput: z.unknown(),
  dedupeKey: z.string().optional(),
});

export const notificationEmitSchema = z.object({
  chunkInput: z.unknown(),
  dedupeKey: z.string().optional(),
});

export const notificationPolicyRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  scopeType: z.string(),
  scopeId: z.string().nullable(),
  defaultChannels: z.array(z.string()).nullable(),
  canUserOverride: z.boolean().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const notificationPolicyListSchema = z.array(notificationPolicyRowSchema);

const DELIVERY_CHANNELS = ["IN_APP", "EMAIL", "PUSH", "SMS", "WHATSAPP"] as const;

export const notificationPreferenceSchema = z.object({
  userId: z.string(),
  orgId: z.string(),
  emailEnabled: z.boolean(),
  pushEnabled: z.boolean(),
  smsEnabled: z.boolean(),
  whatsappEnabled: z.boolean(),
  inAppEnabled: z.boolean(),
  soundEnabled: z.boolean(),
  quietHoursStart: z.string().nullable(),
  quietHoursEnd: z.string().nullable(),
  quietHoursWeekends: z.boolean(),
  allowCriticalOverride: z.boolean(),
  digestMode: z.string(),
  categories: z.record(z.string(), z.boolean()),
  channelCategories: z.record(z.string(), z.record(z.string(), z.boolean())),
  eventPreferences: z.record(z.string(), z.unknown()),
  modulePreferences: z.record(z.string(), z.unknown()),
  inherited: z
    .object({
      defaultChannels: z.array(z.string()),
      canUserOverride: z.boolean(),
    })
    .optional(),
  availableChannels: z.array(z.enum(DELIVERY_CHANNELS)).optional(),
});

export const preferenceRuleOkSchema = z.object({ ok: z.literal(true) });

const eventCatalogItemSchema = z.object({
  eventKey: z.string(),
  displayName: z.string(),
  description: z.string(),
  category: z.string(),
  sourceModule: z.string().nullable(),
  priority: z.string(),
  defaultChannels: z.array(z.string()),
  allowedChannels: z.array(z.string()),
  mandatory: z.boolean(),
  userConfigurable: z.boolean(),
  userPreference: z.unknown().nullable(),
});

export const notificationEventCatalogSchema = z.array(eventCatalogItemSchema);

export const suppressionRowSchema = z.object({
  id: z.number().int(),
  scopeType: z.string(),
  scopeKey: z.string(),
  channel: z.string().nullable(),
  reason: z.string(),
  expiresAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const notificationSuppressionsListSchema = z.array(suppressionRowSchema);

export const consentRowSchema = z.object({
  channel: z.string(),
  destination: z.string(),
  state: z.string(),
  source: z.string(),
  legalBasis: z.string(),
  grantedAt: nullableWireDate(),
  withdrawnAt: nullableWireDate(),
  updatedAt: wireDate(),
});

export const notificationConsentsListSchema = z.array(consentRowSchema);

export const notificationSuccessSchema = z.object({ success: z.literal(true) });

export const notificationProviderRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  channel: z.string(),
  provider: z.string(),
  displayName: z.string(),
  enabled: z.boolean(),
  sandboxMode: z.boolean(),
  isDefault: z.boolean(),
  dailySendLimit: z.number().int().nullable(),
  monthlyCostLimit: z.number().int().nullable(),
  healthStatus: z.string(),
  lastTestedAt: nullableWireDate(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  hasCredentials: z.boolean(),
});

export const notificationProvidersListSchema = z.array(notificationProviderRowSchema);

export const notificationProviderTestSchema = z.object({
  status: z.string(),
  sandbox: z.boolean(),
  message: z.string(),
  providerMessageId: z.string().nullable(),
});

export const notificationTemplateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  templateKey: z.string(),
  name: z.string(),
  channel: z.string(),
  category: z.string(),
  locale: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  variables: z.array(z.string()),
  version: z.number().int(),
  isActive: z.boolean(),
  approvalStatus: z.string(),
  providerTemplateName: z.string().nullable(),
  approvalCheckedAt: nullableWireDate(),
  approvalRejectionReason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const notificationTemplatesListSchema = z.object({
  items: z.array(notificationTemplateRowSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export const templatePreviewSchema = z.object({
  subject: z.string().optional(),
  body: z.string(),
  channel: z.string(),
  templateKey: z.string(),
});

export const templateTestSendSchema = z.object({
  success: z.literal(true),
  recipientId: z.string(),
  channel: z.string(),
  subject: z.string().optional(),
  body: z.string(),
  sentAt: z.string(),
});

export const notificationPreferenceRuleRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  membershipId: z.number().int(),
  scopeType: z.enum(["EVENT", "MODULE", "CATEGORY"]),
  scopeKey: z.string(),
  channel: z.string(),
  mode: z.enum(["ON", "OFF", "DIGEST"]),
  updatedAt: wireDate(),
});

export const notificationPreferenceRulesListSchema = z.array(notificationPreferenceRuleRowSchema);
