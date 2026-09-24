/**
 * The recruitment domain events a tenant may subscribe a webhook to, and — via
 * `RecruitmentOutboxConsumer` — the set the outbox has a consumer for.
 *
 * `hire.handoff` is here because an offer acceptance emits it and an event with
 * no registered consumer dead-letters rather than being ignored. It is the
 * "this person is now an employee record" signal, distinct from
 * `candidate.hired`, which is about the pipeline.
 */
export const RECRUITMENT_EVENTS = [
  "candidate.applied",
  "candidate.moved",
  "candidate.hired",
  "candidate.rejected",
  "hire.handoff",
] as const;

export type RecruitmentEvent = typeof RECRUITMENT_EVENTS[number];

export const RECRUITMENT_EVENT_SAMPLE_PAYLOADS: Record<RecruitmentEvent, Record<string, unknown>> = {
  "candidate.applied": { candidateId: 1, jobPostingId: 1 },
  "candidate.moved": { candidateId: 1, jobPostingId: 1, fromStage: "NEW", toStage: "INTERVIEW" },
  "candidate.hired": { candidateId: 1, jobPostingId: 1 },
  /*
    `reason` is a code from the closed catalog in
    `disposition/rejection-reasons.ts`, not the prose this sample used to
    promise. A subscriber keying on prose breaks the first time a label is
    reworded, and until migration 1185 the emitter sent no reason at all — the
    documented field arrived undefined on every delivery.
  */
  "candidate.rejected": {
    candidateId: 1,
    jobPostingId: 1,
    reason: "NOTICE_PERIOD",
    reasonNote: null,
  },
  "hire.handoff": { candidateId: 1, jobPostingId: 1, offerId: 1 },
};

export const RECRUITMENT_EVENT_FIELD_DOCS: Record<RecruitmentEvent, Record<string, string>> = {
  "candidate.applied": { candidateId: "ID of the candidate", jobPostingId: "ID of the job" },
  "candidate.moved": { candidateId: "ID of the candidate", jobPostingId: "ID of the job", fromStage: "Previous stage", toStage: "New stage" },
  "candidate.hired": { candidateId: "ID of the candidate", jobPostingId: "ID of the job" },
  "candidate.rejected": { candidateId: "ID of the candidate", jobPostingId: "ID of the job", reason: "Rejection reason code from the fixed catalog", reasonNote: "Free-text note, required only for OTHER" },
  "hire.handoff": { candidateId: "ID of the candidate", jobPostingId: "ID of the job", offerId: "ID of the accepted offer" },
};
