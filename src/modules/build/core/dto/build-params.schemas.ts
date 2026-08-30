import { z } from "zod";

const intId = z.coerce.number().int().positive();

export const projectIdParams = z.object({ projectId: intId }).strict();
export type ProjectIdParams = z.infer<typeof projectIdParams>;

export const ticketIdParams = z.object({ ticketId: intId }).strict();
export type TicketIdParams = z.infer<typeof ticketIdParams>;

export const projectAndTicketParams = z.object({ projectId: intId, ticketId: intId }).strict();
export type ProjectAndTicketParams = z.infer<typeof projectAndTicketParams>;

export const projectAndReleaseParams = z.object({ projectId: intId, releaseId: intId }).strict();
export type ProjectAndReleaseParams = z.infer<typeof projectAndReleaseParams>;

export const projectAndApprovalParams = z.object({ projectId: intId, approvalId: intId }).strict();
export type ProjectAndApprovalParams = z.infer<typeof projectAndApprovalParams>;

export const projectAndAutomationParams = z.object({ projectId: intId, automationId: intId }).strict();
export type ProjectAndAutomationParams = z.infer<typeof projectAndAutomationParams>;

export const projectAndWebhookParams = z.object({ projectId: intId, webhookId: intId }).strict();
export type ProjectAndWebhookParams = z.infer<typeof projectAndWebhookParams>;

export const projectAndTicketAndCommentParams = z
  .object({ projectId: intId, ticketId: intId, commentId: intId })
  .strict();
export type ProjectAndTicketAndCommentParams = z.infer<typeof projectAndTicketAndCommentParams>;

export const projectAndTicketAndChecklistParams = z
  .object({ projectId: intId, ticketId: intId, checklistId: intId })
  .strict();
export type ProjectAndTicketAndChecklistParams = z.infer<typeof projectAndTicketAndChecklistParams>;

export const projectAndTicketAndItemParams = z
  .object({ projectId: intId, ticketId: intId, itemId: intId })
  .strict();
export type ProjectAndTicketAndItemParams = z.infer<typeof projectAndTicketAndItemParams>;

export const projectAndFieldParams = z.object({ projectId: intId, fieldId: intId }).strict();
export type ProjectAndFieldParams = z.infer<typeof projectAndFieldParams>;

export const projectAndTicketAndFieldParams = z
  .object({ projectId: intId, ticketId: intId, fieldId: intId })
  .strict();
export type ProjectAndTicketAndFieldParams = z.infer<typeof projectAndTicketAndFieldParams>;

export const projectAndStateParams = z.object({ projectId: intId, stateId: intId }).strict();
export type ProjectAndStateParams = z.infer<typeof projectAndStateParams>;

export const projectAndStatusParams = z.object({ projectId: intId, statusId: intId }).strict();
export type ProjectAndStatusParams = z.infer<typeof projectAndStatusParams>;

export const projectAndTransitionParams = z
  .object({ projectId: intId, transitionId: intId })
  .strict();
export type ProjectAndTransitionParams = z.infer<typeof projectAndTransitionParams>;

export const projectAndMilestoneParams = z.object({ projectId: intId, milestoneId: intId }).strict();
export type ProjectAndMilestoneParams = z.infer<typeof projectAndMilestoneParams>;

export const projectAndSprintParams = z.object({ projectId: intId, sprintId: intId }).strict();
export type ProjectAndSprintParams = z.infer<typeof projectAndSprintParams>;

export const projectAndTeamParams = z.object({ projectId: intId, teamId: intId }).strict();
export type ProjectAndTeamParams = z.infer<typeof projectAndTeamParams>;

export const projectAndFormParams = z.object({ projectId: intId, formId: intId }).strict();
export type ProjectAndFormParams = z.infer<typeof projectAndFormParams>;

export const projectFormAndSubmissionParams = z
  .object({ projectId: intId, formId: intId, submissionId: intId })
  .strict();
export type ProjectFormAndSubmissionParams = z.infer<typeof projectFormAndSubmissionParams>;

export const projectAndDecisionParams = z.object({ projectId: intId, decisionId: intId }).strict();
export type ProjectAndDecisionParams = z.infer<typeof projectAndDecisionParams>;

export const projectAndRiskParams = z.object({ projectId: intId, riskId: intId }).strict();
export type ProjectAndRiskParams = z.infer<typeof projectAndRiskParams>;

export const projectAndIncidentParams = z.object({ projectId: intId, incidentId: intId }).strict();
export type ProjectAndIncidentParams = z.infer<typeof projectAndIncidentParams>;

export const projectAndMeetingParams = z.object({ projectId: intId, meetingId: intId }).strict();
export type ProjectAndMeetingParams = z.infer<typeof projectAndMeetingParams>;

export const projectAndPortfolioParams = z.object({ projectId: intId, portfolioId: intId }).strict();
export type ProjectAndPortfolioParams = z.infer<typeof projectAndPortfolioParams>;

export const portfolioIdParams = z.object({ portfolioId: intId }).strict();
export type PortfolioIdParams = z.infer<typeof portfolioIdParams>;

export const projectAndProgramParams = z.object({ projectId: intId, programId: intId }).strict();
export type ProjectAndProgramParams = z.infer<typeof projectAndProgramParams>;

export const programIdParams = z.object({ programId: intId }).strict();
export type ProgramIdParams = z.infer<typeof programIdParams>;

export const projectAndBugParams = z.object({ projectId: intId, bugId: intId }).strict();
export type ProjectAndBugParams = z.infer<typeof projectAndBugParams>;

export const projectAndCaseParams = z.object({ projectId: intId, caseId: intId }).strict();
export type ProjectAndCaseParams = z.infer<typeof projectAndCaseParams>;

export const projectRunAndResultParams = z
  .object({ projectId: intId, runId: intId, resultId: intId })
  .strict();
export type ProjectRunAndResultParams = z.infer<typeof projectRunAndResultParams>;

export const projectAndRunParams = z.object({ projectId: intId, runId: intId }).strict();
export type ProjectAndRunParams = z.infer<typeof projectAndRunParams>;

export const projectAndSuiteParams = z.object({ projectId: intId, suiteId: intId }).strict();
export type ProjectAndSuiteParams = z.infer<typeof projectAndSuiteParams>;

export const whiteboardIdParams = z.object({ whiteboardId: intId }).strict();
export type WhiteboardIdParams = z.infer<typeof whiteboardIdParams>;

export const projectAndWhiteboardParams = z.object({ projectId: intId, whiteboardId: intId }).strict();
export type ProjectAndWhiteboardParams = z.infer<typeof projectAndWhiteboardParams>;

export const managedProductIdParams = z.object({ managedProductId: intId }).strict();
export type ManagedProductIdParams = z.infer<typeof managedProductIdParams>;

export const pmWorkspaceIdParams = z
  .object({ pmWorkspaceId: z.string().min(1) })
  .strict();
export type PmWorkspaceIdParams = z.infer<typeof pmWorkspaceIdParams>;

export const pmWorkspaceAndMembershipParams = z
  .object({ pmWorkspaceId: z.string().min(1), pmWorkspaceMembershipId: z.string().min(1) })
  .strict();
export type PmWorkspaceAndMembershipParams = z.infer<typeof pmWorkspaceAndMembershipParams>;

export const ticketAndDraftParams = z
  .object({ ticketId: intId, draftId: intId })
  .strict();
export type TicketAndDraftParams = z.infer<typeof ticketAndDraftParams>;

export const ticketAndEntryParams = z
  .object({ ticketId: intId, entryId: intId })
  .strict();
export type TicketAndEntryParams = z.infer<typeof ticketAndEntryParams>;

export const changeRequestIdParams = z.object({ changeRequestId: intId }).strict();
export type ChangeRequestIdParams = z.infer<typeof changeRequestIdParams>;

export const projectAndChangeRequestParams = z
  .object({ projectId: intId, changeRequestId: intId })
  .strict();
export type ProjectAndChangeRequestParams = z.infer<typeof projectAndChangeRequestParams>;

export const projectAndLabelParams = z.object({ projectId: intId, labelId: intId }).strict();
export type ProjectAndLabelParams = z.infer<typeof projectAndLabelParams>;

export const projectTicketAndLinkParams = z
  .object({ projectId: intId, ticketId: intId, linkId: intId })
  .strict();
export type ProjectTicketAndLinkParams = z.infer<typeof projectTicketAndLinkParams>;

export const projectTicketAndLabelParams = z
  .object({ projectId: intId, ticketId: intId, labelId: intId })
  .strict();
export type ProjectTicketAndLabelParams = z.infer<typeof projectTicketAndLabelParams>;

export const meetingAndItemParams = z.object({ meetingId: intId, itemId: intId }).strict();
export type MeetingAndItemParams = z.infer<typeof meetingAndItemParams>;

export const projectMeetingAndItemParams = z
  .object({ projectId: intId, meetingId: intId, itemId: intId })
  .strict();
export type ProjectMeetingAndItemParams = z.infer<typeof projectMeetingAndItemParams>;

export const templateIdParams = z.object({ templateId: intId }).strict();
export type TemplateIdParams = z.infer<typeof templateIdParams>;
