import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

export const operatorScopeSchema = z.enum([
  "read_customer_data",
  "read_messages",
  "read_payments",
  "read_leads",
  "manage_subscription",
]);

export const createGrantSchema = z.object({
  operatorUserId: z.string().min(1).max(256),
  orgId: z.string().min(1).max(256),
  incidentRef: z.string().min(1).max(500),
  reason: z.string().trim().min(3).max(1000),
  scope: operatorScopeSchema,
  expiresAt: z.string().datetime(),
}).strict().refine(
  (value) => value.reason.trim().toLowerCase() !== value.incidentRef.trim().toLowerCase(),
  { message: "Reason must be distinct from incident reference", path: ["reason"] },
);

export type CreateGrantInput = z.infer<typeof createGrantSchema>;

export const revokeGrantSchema = z.object({
  reason: z.string().min(1).max(1000),
}).strict();

export type RevokeGrantInput = z.infer<typeof revokeGrantSchema>;

export const grantStatusSchema = z.enum(["pending", "active", "rejected", "revoked", "expired"]);

export const listGrantsQuerySchema = z.object({
  orgId: z.string().min(1).max(256),
  status: grantStatusSchema.optional(),
}).strict();

export type ListGrantsQuery = z.infer<typeof listGrantsQuerySchema>;

export const listLogsQuerySchema = z.object({
  orgId: z.string().min(1).max(256),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

export type ListLogsQuery = z.infer<typeof listLogsQuerySchema>;

export const operatorOrgParamsSchema = z.object({
  orgId: z.string().min(1).max(256),
}).strict();

export const visitSchema = z.object({
  sessionToken: z.string().min(1).max(64),
  path: z.string().min(1).max(500),
  referrer: z.string().max(500).nullish(),
}).strict();

export type VisitInput = z.infer<typeof visitSchema>;

export const visitUsageResponseSchema = z.object({ usage: z.string() }).strict();
type VisitUsageResponse = z.infer<typeof visitUsageResponseSchema>;

export const listMessagesQuerySchema = z.object({
  status: z.enum(["NEW", "READ", "REPLIED", "ARCHIVED", "ALL"]).optional(),
  topic: z.string().optional(),
  search: z.string().optional(),
}).strict();

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export const contactFormSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  company: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  message: z.string().min(1).max(5000),
  topic: z.enum(["sales", "support", "partnership", "press", "other"]).optional(),
}).strict();
export type ContactFormInput = z.infer<typeof contactFormSchema>;

export const listCustomersQuerySchema = z.object({
  afterCreatedAt: z.string().datetime().optional(),
  afterId: z.string().min(1).max(256).optional(),
}).refine(
  (v) => (v.afterCreatedAt === undefined) === (v.afterId === undefined),
  { message: "afterCreatedAt and afterId must both be present or both absent" },
);
type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;


/**
 * PRD-C049 — the response half of the operator-access contract.
 *
 * `check:openapi-coverage` measures how many operations publish a 2xx CONTENT schema.
 * Every operation on this controller published a bare auto-generated `"200": {}`, which
 * NestJS emits for every handler and which the gate's own header calls "not a contract".
 * These four handlers return a literal declared in the controller itself, so the schema
 * is read off the `return` statement rather than inferred — and
 * `ResponseContractInterceptor` compares it against the real value on every request
 * under `NODE_ENV=test`, so a wrong one fails the suite instead of becoming decoration.
 *
 * NOT `.strict()`, matching the repository's response-schema policy: an added field is a
 * backward-compatible deploy, a removed or retyped one is the drift these exist to catch.
 */
export const operatorAccessAckResponseSchema = z.object({ ok: z.literal(true) });

export const operatorAccessGrantCreatedResponseSchema = z.object({ grantId: z.string() });

/** `PlatformOperatorAccessService.listGrants` — the nine-column projection at :415. */
export const operatorAccessGrantListResponseSchema = z.array(
  z.object({
    grantId: z.string(),
    operatorUserId: z.string(),
    incidentRef: z.string(),
    grantedBy: z.string(),
    approverId: z.string().nullable(),
    scope: z.string(),
    status: z.string(),
    expiresAt: wireDate(),
    createdAt: wireDate(),
  }),
);

/** `PlatformOperatorAccessService.listLogs` — the six-column projection at :432. */
export const operatorAccessLogListResponseSchema = z.array(
  z.object({
    logId: z.string(),
    grantId: z.string(),
    operatorUserId: z.string(),
    action: z.string(),
    ipAddress: z.string().nullable(),
    accessedAt: wireDate(),
  }),
);
