import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const recruiterPortalSchema = z.object({
  id: z.number().int(),
  platform: z.string(),
  isActive: z.boolean(),
  lastSyncedAt: nullableWireDate(),
  lastSyncCount: z.number().int().nullable(),
  createdAt: wireDate(),
});

/**
 * `SYNC_INITIATED` is gone. It was returned with a message promising
 * applications "shortly" from a call that reached no platform. Either a board
 * answered (`SYNCED`, with how many rows it gave us) or it did not
 * (`BLOCKED`, with why).
 */
export const syncPortalResponseSchema = z.discriminatedUnion("status", [
  z.object({
    platform: z.string(),
    status: z.literal("BLOCKED"),
    code: z.enum(["no-integration", "inactive", "needs-keys", "not-implemented"]),
    message: z.string(),
    lastSyncedAt: z.union([z.string(), z.date()]).nullable(),
  }),
  z.object({
    platform: z.string(),
    status: z.literal("SYNCED"),
    fetched: z.number().int(),
    lastSyncedAt: z.string(),
  }),
]);

export const recruiterDirectoryItemSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  assignedJobsCount: z.number().int(),
  activitySummary: z.record(z.string(), z.number().int()),
});

export const recruiterActivityItemSchema = z.object({
  id: z.number().int(),
  recruiterId: z.string(),
  action: z.string(),
  candidateId: z.number().int().nullable(),
  jobPostingId: z.number().int().nullable(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  recruiterName: z.string().nullable(),
  candidateFirstName: z.string().nullable(),
  candidateLastName: z.string().nullable(),
  jobTitle: z.string().nullable(),
});

export const recruiterActivityLogRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  recruiterId: z.string(),
  action: z.string(),
  candidateId: z.number().int().nullable(),
  jobPostingId: z.number().int().nullable(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
});
