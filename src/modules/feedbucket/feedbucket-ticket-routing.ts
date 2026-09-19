import type { FeedbucketAssigneeRules } from "../../db/schema";

export interface FeedbucketTicketRoutingWidget {
  projectId: number | null;
  defaultProjectId: number | null;
  defaultAssigneeMembershipId: number | null;
  assigneeRules: FeedbucketAssigneeRules | null;
}

export interface FeedbucketTicketOverride {
  projectId?: number;
  assigneeMembershipId?: number;
}

const FEEDBACK_TITLE_MAX = 120;

export function deriveFeedbackTicketTitle(
  message: string,
  submissionType: keyof FeedbucketAssigneeRules,
): string {
  const firstLine = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return `${submissionType} feedback`;

  const sentence = firstLine.split(/(?<=[.!?])\s/)[0]?.trim() ?? firstLine;
  const candidate = sentence.replace(/[\s:;,\-–—]+$/, "");
  if (candidate.length <= FEEDBACK_TITLE_MAX) return candidate;

  const clipped = candidate.slice(0, FEEDBACK_TITLE_MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  const trimmed = (lastSpace > FEEDBACK_TITLE_MAX / 2 ? clipped.slice(0, lastSpace) : clipped)
    .replace(/[\s:;,\-–—]+$/, "");
  return `${trimmed}…`;
}

export function resolveFeedbucketTicketTarget(
  widget: FeedbucketTicketRoutingWidget,
  submissionType: keyof FeedbucketAssigneeRules,
  override?: FeedbucketTicketOverride,
): { projectId: number | null; assigneeMembershipId: number | null } {
  const projectId = override?.projectId ?? widget.projectId ?? widget.defaultProjectId ?? null;
  const ruleAssignee = widget.assigneeRules?.[submissionType];
  const assigneeMembershipId =
    override?.assigneeMembershipId ?? ruleAssignee ?? widget.defaultAssigneeMembershipId ?? null;
  return { projectId, assigneeMembershipId };
}
