import type { ZodType } from "zod";
import { DB_ENUMS } from "../../../../db/enums.generated";
import {
  projectListItemSchema,
  projectReleaseListItemSchema,
  projectReleaseRowSchema,
  projectWebhookSchema,
  webhookDeliverySchema,
  automationRunActionRowSchema,
  automationRunRowSchema,
} from "./build-core-response.schemas";
import { projectRowSchema } from "./build-project-detail-response.schemas";
import {
  ticketListRowSchema,
  ticketSearchResultSchema,
  ticketActivityPageSchema,
  ticketRelationListItemSchema,
  gitLinkSchema,
  allWorkItemSchema,
} from "./build-tickets-response.schemas";
import { analyticsSchema } from "./build-reports-response.schemas";
import { RELEASE_STATUSES } from "./releases.schemas";
import { changelogEntrySchema } from "./build-roadmap-response.schemas";
import { timesheetRowSchema } from "../../execution/dto/timesheets-response.schemas";
import { viewRowSchema } from "../../execution/dto/workspace-response.schemas";
import { projectStatusSchema as workflowStateSchema } from "../../workflow/dto/workflow-response.schemas";
import {
  testCaseRowSchema,
  testRunRowSchema,
  testRunResultRowSchema,
  bugRowSchema,
} from "../../qa/dto/qa-response.schemas";
import { updateRowSchema } from "../../updates/dto/updates-response.schemas";
import { importPreviewValuesSchema } from "../../import-export/dto/import-export-response.schemas";
import {
  portalProjectItemSchema,
  portalChangeRequestItemSchema,
  visibilitySummarySchema,
} from "../../client-portal/dto/client-portal-response.schemas";
import { changeRequestAffectedItemSchema } from "../../client-portal/dto/change-request-affected-items-response.schemas";
import { roadmapSchema, roadmapVoteSchema } from "../../../public/dto/public-response.schemas";

const OUT_OF_SET = "__not_a_member__";

type FieldCase = readonly [string, ZodType, readonly string[]];

const cases: FieldCase[] = [
  ["project list status", projectListItemSchema.shape.status, DB_ENUMS.project_status],
  ["project row status", projectRowSchema.shape.status, DB_ENUMS.project_status],
  ["release list status", projectReleaseListItemSchema.shape.status, RELEASE_STATUSES],
  ["release row status", projectReleaseRowSchema.shape.status, RELEASE_STATUSES],
  ["webhook delivery status", webhookDeliverySchema.shape.status, ["pending", "success", "failed"]],
  ["webhook last delivery status", projectWebhookSchema.shape.lastDeliveryStatus.unwrap(), ["pending", "success", "failed"]],
  ["automation run action outcome", automationRunActionRowSchema.shape.outcome, DB_ENUMS.automation_action_outcome],
  ["automation run outcome", automationRunRowSchema.shape.outcome, DB_ENUMS.automation_run_outcome],
  ["ticket list cycle status", ticketListRowSchema.shape.cycle.unwrap().shape.status, DB_ENUMS.cycle_status],
  ["ticket search priority", ticketSearchResultSchema.shape.priority, DB_ENUMS.ticket_priority],
  ["ticket activity action", ticketActivityPageSchema.shape.data.element.shape.action, DB_ENUMS.ticket_activity_action],
  ["relation list related priority", ticketRelationListItemSchema.shape.relatedTicket.shape.priority, DB_ENUMS.ticket_priority],
  ["relation list related type", ticketRelationListItemSchema.shape.relatedTicket.shape.type, DB_ENUMS.ticket_type],
  ["relation list relation type", ticketRelationListItemSchema.shape.relationType, DB_ENUMS.work_item_relation_type],
  ["git link provider", gitLinkSchema.shape.provider, DB_ENUMS.git_provider],
  ["git link ref type", gitLinkSchema.shape.refType, DB_ENUMS.git_ref_type],
  ["all work type", allWorkItemSchema.shape.type, DB_ENUMS.ticket_type],
  ["all work priority", allWorkItemSchema.shape.priority.unwrap(), DB_ENUMS.ticket_priority],
  ["analytics health status", analyticsSchema.shape.healthStatus, ["NOT_STARTED", "EXCELLENT", "GOOD", "AT_RISK", "CRITICAL"]],
  ["timesheet status", timesheetRowSchema.shape.status, DB_ENUMS.timesheet_entry_status],
  ["timesheet payroll status", timesheetRowSchema.shape.payrollStatus.unwrap(), DB_ENUMS.timesheet_payroll_status],
  ["timesheet billing type", timesheetRowSchema.shape.billingType.unwrap(), DB_ENUMS.timesheet_billing_type],
  ["timesheet rate source", timesheetRowSchema.shape.rateSource.unwrap(), DB_ENUMS.timesheet_rate_source],
  ["timesheet invoicing status", timesheetRowSchema.shape.invoicingStatus.unwrap(), DB_ENUMS.timesheet_invoicing_status],
  ["timesheet source", timesheetRowSchema.shape.source, DB_ENUMS.timesheet_entry_source],
  ["view layout type", viewRowSchema.shape.layoutType, DB_ENUMS.view_layout],
  ["workflow state type", workflowStateSchema.shape.type, DB_ENUMS.state_group],
  ["build changelog type", changelogEntrySchema.shape.type, DB_ENUMS.changelog_type],
  ["test case priority", testCaseRowSchema.shape.priority, DB_ENUMS.test_case_priority],
  ["test case automation status", testCaseRowSchema.shape.automationStatus, DB_ENUMS.test_case_automation_status],
  ["test run status", testRunRowSchema.shape.status, DB_ENUMS.test_run_status],
  ["test run result status", testRunResultRowSchema.shape.status, DB_ENUMS.test_result_status],
  ["bug priority", bugRowSchema.shape.priority, DB_ENUMS.ticket_priority],
  ["bug qa state", bugRowSchema.shape.qaState.unwrap(), DB_ENUMS.bug_status],
  ["bug severity", bugRowSchema.shape.severity.unwrap(), DB_ENUMS.bug_severity],
  ["project update status", updateRowSchema.shape.status, DB_ENUMS.project_update_status],
  ["project update audience", updateRowSchema.shape.audience, DB_ENUMS.project_update_audience],
  ["import preview type", importPreviewValuesSchema.shape.type.unwrap(), DB_ENUMS.ticket_type],
  ["import preview priority", importPreviewValuesSchema.shape.priority.unwrap(), DB_ENUMS.ticket_priority],
  ["portal project status", portalProjectItemSchema.shape.status, DB_ENUMS.project_status],
  ["portal change request status", portalChangeRequestItemSchema.shape.status, DB_ENUMS.change_request_status],
  ["client visibility ticket type", visibilitySummarySchema.shape.tickets.shape.data.element.shape.type, DB_ENUMS.ticket_type],
  ["affected ticket priority", changeRequestAffectedItemSchema.shape.ticket.shape.priority, DB_ENUMS.ticket_priority],
  ["affected ticket type", changeRequestAffectedItemSchema.shape.ticket.shape.type, DB_ENUMS.ticket_type],
  ["public roadmap item status", roadmapSchema.shape.roadmap.shape.planned.element.shape.status, DB_ENUMS.roadmap_status],
  ["public changelog type", roadmapSchema.shape.changelog.element.shape.type.unwrap(), DB_ENUMS.changelog_type],
  ["public roadmap vote type", roadmapVoteSchema.shape.type, ["roadmap", "feedback"]],
];

describe("Build response fields are declared over the closed set that decides their values", () => {
  it.each(cases)("%s accepts every member of its source set", (_label, schema, members) => {
    for (const member of members) expect(schema.safeParse(member).success).toBe(true);
  });

  it.each(cases)(
    "%s rejects a value outside its source set so the published contract is an enum, not an open string",
    (_label, schema) => {
      expect(schema.safeParse(OUT_OF_SET).success).toBe(false);
    },
  );
});

describe("Build response nullability is not widened by the enum narrowing", () => {
  it("keeps the workflow state type non-null, matching the contract the frontend already parses", () => {
    expect(workflowStateSchema.shape.type.safeParse(null).success).toBe(false);
    expect(workflowStateSchema.shape.type.safeParse("started").success).toBe(true);
  });
});
