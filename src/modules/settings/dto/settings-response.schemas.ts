import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../common/openapi/response-envelopes";

/**
 * Response contract for `SettingsController` and
 * `SettingsDeprecatedRoutesController` handlers.
 *
 * Derived from service projections and Drizzle column types. NOT `.strict()`:
 * extra response fields are backward-compatible; removed/retyped fields are
 * what these schemas exist to catch.
 */

/**
 * `SettingsService.getSectionProvenance` — last audit-log entry per settings
 * section. Keys are the requested section strings; values are null when no
 * audit row exists.
 */
export const settingsProvenanceResponseSchema = z.record(
  z.string(),
  z.object({
    actorId: z.string(),
    actorName: z.string().nullable(),
    action: z.string(),
    at: z.string(),
  }).nullable(),
);

/**
 * A single API key row — `api_keys` table minus `keyHash`, joined with
 * the creator user's name and email. `lastUsedAt` and `expiresAt` are
 * nullable timestamps; `scopes` is `text[]`.
 */
export const apiKeyItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  description: z.string().nullable(),
  scopes: z.array(z.string()),
  isRevoked: z.boolean(),
  lastUsedAt: nullableWireDate(),
  expiresAt: nullableWireDate(),
  createdBy: z.string(),
  createdAt: wireDate(),
  creator: z.object({
    name: z.string().nullable(),
    email: z.string(),
  }),
});

/** `SettingsService.listApiKeys` — capped array of non-revoked keys. */
export const apiKeyListResponseSchema = z.array(apiKeyItemSchema);

/**
 * `SettingsService.createApiKey` — returns the raw key ONCE on creation.
 * The `key` field is the only exposure; subsequent reads only see `keyPrefix`.
 */
export const apiKeyCreateResponseSchema = z.object({
  id: z.string(),
  key: z.string(),
  keyPrefix: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
});

/** `SettingsService.revokeApiKey` */
export const apiKeyRevokeResponseSchema = z.object({ success: z.literal(true) });

/**
 * A single automation rule — the full `automation_rules` row as returned by
 * `createAutomation`, `getAutomation`, and `updateAutomation`.
 */
export const automationRuleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  triggerEvent: z.string(),
  conditions: z.unknown(),
  actions: z.unknown(),
  isEnabled: z.boolean(),
  runCount: z.number().int(),
  lastRunAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** The list projection omits `orgId` and `createdBy` — distinct from the full row. */
const automationRuleListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  triggerEvent: z.string(),
  conditions: z.unknown(),
  actions: z.unknown(),
  isEnabled: z.boolean(),
  runCount: z.number().int(),
  lastRunAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `SettingsAutomationsService.listAutomations` — cursor-paged list. */
export const automationListResponseSchema = cursorPageSchema(automationRuleListItemSchema);

/** `SettingsAutomationsService.createAutomation` / `getAutomation` / `updateAutomation` */
export const automationResponseSchema = automationRuleSchema;

/** `SettingsAutomationsService.deleteAutomation` */
export const automationDeleteResponseSchema = z.object({ success: z.literal(true) });

/** A single automation run — `SettingsAutomationsService.listAutomationRuns` projection. */
export const automationRunItemSchema = z.object({
  id: z.number().int(),
  triggerEvent: z.string(),
  status: z.string(),
  payload: z.unknown().nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  createdAt: wireDate(),
});

/** `SettingsAutomationsService.listAutomationRuns` */
export const automationRunsListResponseSchema = z.array(automationRunItemSchema);

/**
 * `SettingsService.getFeatureFlags` — `parseOrgFeatureFlags` output.
 * All fields are boolean flags.
 */
export const featureFlagsResponseSchema = z.object({
  aiChat: z.boolean(),
  aiLeadScoring: z.boolean(),
  aiEmailDraft: z.boolean(),
  aiSmartNotifications: z.boolean(),
  aiWeeklyRecap: z.boolean(),
  supportAi: z.boolean(),
});

/** `SettingsService.updateFeatureFlag` */
export const updateFeatureFlagResponseSchema = z.object({
  success: z.literal(true),
  flag: z.string(),
  enabled: z.boolean(),
});

/** `SettingsService.updateUserRole` (deprecated route) */
export const updateUserRoleResponseSchema = z.object({
  success: z.literal(true),
  userId: z.string(),
  role: z.string(),
});

/**
 * `AiUsageService.getOrgUsage` — `queryAiUsage` result shape from
 * `ai-usage.query.ts`.
 */
export const aiUsageResponseSchema = z.object({
  totals: z.object({
    totalTokens: z.number(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    estimatedCostUsd: z.string(),
    requestCount: z.number().int(),
  }),
  byFeature: z.array(z.object({
    feature: z.string(),
    model: z.string(),
    totalTokens: z.number(),
    estimatedCostUsd: z.string(),
    requestCount: z.number().int(),
  })),
  daily: z.array(z.object({
    date: z.string(),
    totalTokens: z.number(),
    estimatedCostUsd: z.string(),
    requestCount: z.number().int(),
  })),
  performance: z.object({
    avgLatencyMs: z.number().nullable(),
    p95LatencyMs: z.number().nullable(),
    errorRate: z.number(),
  }),
  acceptance: z.object({
    feedbackByFeature: z.array(z.object({
      feature: z.string(),
      up: z.number().int(),
      down: z.number().int(),
      total: z.number().int(),
      ratio: z.number().nullable(),
    })),
    supportSuggestions: z.object({
      accepted: z.number().int(),
      rejected: z.number().int(),
      pending: z.number().int(),
    }),
  }),
});

/** A single git connection item in the list response (masked secret, no raw secret). */
export const gitConnectionItemSchema = z.object({
  id: z.number().int(),
  provider: z.string(),
  projectId: z.string().nullable(),
  repoUrl: z.string(),
  repoName: z.string().nullable(),
  isActive: z.boolean(),
  maskedSecret: z.string(),
  webhookUrl: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `GitConnectionsService.listConnections` → alias returns only `page.data`. */
export const gitConnectionListResponseSchema = z.array(gitConnectionItemSchema);

/** `GitConnectionsService.createConnection` — includes the raw `webhookSecret` only on creation. */
export const gitConnectionCreateResponseSchema = z.object({
  id: z.number().int(),
  provider: z.string(),
  projectId: z.string().nullable(),
  repoUrl: z.string(),
  repoName: z.string().nullable(),
  isActive: z.boolean(),
  webhookUrl: z.string(),
  webhookSecret: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `GitConnectionsService.updateConnection` — no raw secret on updates. */
export const gitConnectionUpdateResponseSchema = z.object({
  id: z.number().int(),
  provider: z.string(),
  projectId: z.string().nullable(),
  repoUrl: z.string(),
  repoName: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `GitConnectionsService.deleteConnection` */
export const gitConnectionDeleteResponseSchema = z.object({ success: z.literal(true) });

/** A single custom field definition — `CUSTOM_FIELD_PROJECTION` shape. */
export const customFieldItemSchema = z.object({
  id: z.number().int(),
  entityType: z.string(),
  name: z.string(),
  label: z.string(),
  fieldType: z.string(),
  options: z.array(z.string()).nullable(),
  isRequired: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `CrmCustomFieldsService.listCustomFields` — cursor-paged list. */
export const customFieldListResponseSchema = z.object({
  fields: z.array(customFieldItemSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

/** `CrmCustomFieldsService.createCustomField` / `updateCustomField` */
export const customFieldResponseSchema = z.object({ field: customFieldItemSchema });

/** `CrmCustomFieldsService.deleteCustomField` */
export const customFieldDeleteResponseSchema = z.object({ success: z.literal(true) });
