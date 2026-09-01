import { z } from "zod";

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
  scope: operatorScopeSchema,
  expiresAt: z.string().datetime(),
}).strict();

export type CreateGrantInput = z.infer<typeof createGrantSchema>;

export const revokeGrantSchema = z.object({
  reason: z.string().min(1).max(1000),
}).strict();

export type RevokeGrantInput = z.infer<typeof revokeGrantSchema>;

export const grantStatusSchema = z.enum(["pending", "active", "rejected"]);

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
});

export type VisitInput = z.infer<typeof visitSchema>;

export const visitUsageResponseSchema = z.object({ usage: z.string() }).strict();
export type VisitUsageResponse = z.infer<typeof visitUsageResponseSchema>;

export const listMessagesQuerySchema = z.object({
  status: z.enum(["NEW", "READ", "REPLIED", "ARCHIVED", "ALL"]).optional(),
  topic: z.string().optional(),
  search: z.string().optional(),
});

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export const contactFormSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  company: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  message: z.string().min(1).max(5000),
  topic: z.enum(["sales", "support", "partnership", "press", "other"]).optional(),
});
export type ContactFormInput = z.infer<typeof contactFormSchema>;

export const listCustomersQuerySchema = z.object({
  afterCreatedAt: z.string().datetime().optional(),
  afterId: z.string().min(1).max(256).optional(),
}).refine(
  (v) => (v.afterCreatedAt === undefined) === (v.afterId === undefined),
  { message: "afterCreatedAt and afterId must both be present or both absent" },
);
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

