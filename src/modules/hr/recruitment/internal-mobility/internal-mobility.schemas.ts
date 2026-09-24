import { z } from "zod";

export const internalApprovalDecisionSchema = z
  .object({
    decision: z.enum(["APPROVED", "DECLINED"]),
    /*
      Optional, and capped. The note is read by HR and by the recruiter, never
      by the applicant — a manager writing a candid reason should not have it
      surface on the applicant's own screen, and nothing here sends it there.
    */
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export type InternalApprovalDecisionInput = z.infer<typeof internalApprovalDecisionSchema>;

export const internalApprovalListSchema = z.array(
  z.object({
    applicationId: z.number().int(),
    appliedAt: z.coerce.date(),
    status: z.string(),
    decision: z.string().nullable(),
    decidedAt: z.coerce.date().nullable(),
    note: z.string().nullable(),
    jobTitle: z.string(),
    candidateFirstName: z.string(),
    candidateLastName: z.string(),
  }),
);

export const internalApprovalResultSchema = z.object({
  id: z.number().int(),
  decision: z.string().nullable(),
  decidedAt: z.coerce.date().nullable(),
});

export const internalMyApplicationListSchema = z.array(
  z.object({
    applicationId: z.number().int(),
    appliedAt: z.coerce.date(),
    status: z.string(),
    managerDecision: z.string().nullable(),
    managerDecidedAt: z.coerce.date().nullable(),
    jobTitle: z.string(),
    jobPostingId: z.number().int(),
  }),
);
