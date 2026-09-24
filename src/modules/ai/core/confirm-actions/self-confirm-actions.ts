import { LeavesWriteService } from "../../../hr/time/leaves-write.service";
import { createLeaveSchema } from "../../../hr/time/dto/leaves.schemas";
import { ExpensesWriteService } from "../../../expenses/expenses-write.service";
import { createExpenseSchema } from "../../../expenses/dto/expense.schemas";
import { EntriesService } from "../../../timesheets/core/entries.service";
import { RecruitmentSourcingService } from "../../../hr/recruitment/recruitment-sourcing.service";
import { RecruitmentJobsService } from "../../../hr/recruitment/recruitment-jobs.service";
import { actingMembershipId } from "../../../../common/auth/principal";
import {
  applyLeavePayloadSchema,
  applyToJobOpeningPayloadSchema,
  logTimesheetPayloadSchema,
  submitExpensePayloadSchema,
  submitReferralPayloadSchema,
} from "../dto/confirm-action-payloads.schemas";
import { defineConfirmableAction } from "./confirmable-action.types";

function splitCandidateName(candidateName: string): { firstName: string; lastName: string } {
  const spaceIndex = candidateName.indexOf(" ");
  if (spaceIndex === -1) return { firstName: candidateName, lastName: "" };
  return {
    firstName: candidateName.slice(0, spaceIndex),
    lastName: candidateName.slice(spaceIndex + 1),
  };
}

export const SELF_CONFIRM_ACTIONS = [
  defineConfirmableAction({
    action: "self.applyLeave",
    permission: "self:leaves",
    payload: applyLeavePayloadSchema,
    resolve: (moduleRef) => moduleRef.get(LeavesWriteService, { strict: false }),
    execute: async (payload, { actor }, leaves) => {
      const input = createLeaveSchema.parse({
        leaveTypeId: payload.leaveTypeId,
        startDate: payload.startDate,
        endDate: payload.endDate,
        reason: payload.reason ?? undefined,
      });
      const outcome = await leaves.create(actor, input);
      return {
        result: { success: outcome.success },
        summary: `Leave request submitted from ${input.startDate} to ${input.endDate}`,
      };
    },
  }),

  defineConfirmableAction({
    action: "self.submitExpense",
    permission: "self:expenses",
    payload: submitExpensePayloadSchema,
    resolve: (moduleRef) => moduleRef.get(ExpensesWriteService, { strict: false }),
    execute: async (payload, { actor }, expenses) => {
      const input = createExpenseSchema.parse({
        category: payload.category,
        amount: payload.amount,
        description: payload.description ?? undefined,
        expenseDate: payload.date,
      });
      const expense = await expenses.create(actor.orgId, actor.userId, input);
      return {
        result: { expenseId: expense.id },
        summary: `Expense submitted: ${input.category} — ${input.amount}`,
      };
    },
  }),

  defineConfirmableAction({
    action: "self.logTimesheet",
    permission: "timesheets:entries:create",
    payload: logTimesheetPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(EntriesService, { strict: false }),
    execute: async (payload, { actor }, entries) => {
      const entry = await entries.createEntry(actor, {
        date: payload.date,
        hours: payload.hours,
        projectId: payload.projectId ?? undefined,
        description: payload.description ?? undefined,
      });
      return {
        result: { entryId: entry.id },
        summary: `Logged ${payload.hours}h on ${payload.date}`,
      };
    },
  }),

  defineConfirmableAction({
    action: "self.submitReferral",
    permission: "self:referrals",
    payload: submitReferralPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(RecruitmentSourcingService, { strict: false }),
    execute: async (payload, { actor }, sourcing) => {
      const { firstName, lastName } = splitCandidateName(payload.candidateName);
      const referral = await sourcing.createReferral(
        actor.orgId,
        actor.userId,
        {
          firstName,
          lastName,
          email: payload.candidateEmail,
          jobPostingId: payload.jobPostingId ?? undefined,
          notes: payload.notes ?? undefined,
        },
        actingMembershipId(actor.principal),
      );
      return {
        result: { referralId: referral?.id },
        summary: `Referral submitted for ${payload.candidateName}`,
      };
    },
  }),

  defineConfirmableAction({
    action: "self.applyToJobOpening",
    permission: "self:job-openings",
    payload: applyToJobOpeningPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(RecruitmentJobsService, { strict: false }),
    execute: async (payload, { actor }, jobs) => {
      const application = await jobs.internalApply(actor.orgId, actor.userId, payload.jobId, {
        coverLetter: payload.coverLetter ?? undefined,
        notes: payload.notes ?? undefined,
      });
      return {
        result: { applicationId: application?.id },
        summary: `Applied for job opening #${payload.jobId}`,
      };
    },
  }),
] as const;
