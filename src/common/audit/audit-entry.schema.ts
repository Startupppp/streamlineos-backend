import { z } from "zod";

export const auditEntrySchema = z
  .object({
    action: z.string().min(1),
    userId: z.string().min(1),
    orgId: z.string().nullable().optional(),
    targetId: z.string().nullable().optional(),
    targetType: z.string().nullable().optional(),
    actorUserId: z.string().nullable().optional(),
    actorMembershipId: z.number().int().nullable().optional(),
    resourceType: z.string().nullable().optional(),
    resourceId: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
    ipAddress: z.string().nullable().optional(),
    result: z.enum(["SUCCESS", "FAILURE"]).optional(),
    requestId: z.string().nullable().optional(),
    userAgent: z.string().nullable().optional(),
    before: z.record(z.unknown()).nullable().optional(),
    after: z.record(z.unknown()).nullable().optional(),
  })
  .strict();
