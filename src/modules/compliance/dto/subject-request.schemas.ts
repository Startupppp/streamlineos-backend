import { z } from "zod";

/**
 * `subject_requests.subject_email` says the address is "canonicalised once, at
 * the boundary, so one person is not two requests". This is that boundary.
 */
const subjectEmail = z.string().trim().toLowerCase().email().max(254);

export const executeSubjectRequestSchema = z
  .object({
    /** Same enumeration, different terminal action. See `subject-request.ts`. */
    kind: z.enum(["erasure", "export"]),
    subjectEmail,
    /** The statutory window. Recorded so an overdue request is queryable. */
    dueBy: z.coerce.date().optional(),
    /**
     * Stated by the operator rather than computed, because it comes from the
     * backup schedule and retention policy, which live outside this service.
     */
    backupsExpireBy: z.string().trim().max(64).optional(),
  })
  .strict();

export const listSubjectRequestsQuerySchema = z
  .object({
    subjectEmail: subjectEmail.optional(),
  })
  .strict();

export type ExecuteSubjectRequestInput = z.infer<typeof executeSubjectRequestSchema>;
export type ListSubjectRequestsQuery = z.infer<typeof listSubjectRequestsQuerySchema>;
