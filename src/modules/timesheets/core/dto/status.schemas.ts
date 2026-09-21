import { z } from "zod";
import {
  timesheetApprovalModeEnum,
  timesheetBillingTypeEnum,
  timesheetBudgetStatusEnum,
  timesheetBudgetTypeEnum,
  timesheetEntrySourceEnum,
  timesheetEntryStatusEnum,
  timesheetPayPeriodEnum,
  timesheetPeriodStatusEnum,
  timesheetRoundingRuleEnum,
} from "../../../../db/schema/timesheets/enums";

export const timesheetEntryStatusSchema = z.enum(timesheetEntryStatusEnum.enumValues);
export const timesheetPeriodStatusSchema = z.enum(timesheetPeriodStatusEnum.enumValues);
export const timesheetBillingTypeSchema = z.enum(timesheetBillingTypeEnum.enumValues);
export const timesheetEntrySourceSchema = z.enum(timesheetEntrySourceEnum.enumValues);
export const timesheetBudgetStatusSchema = z.enum(timesheetBudgetStatusEnum.enumValues);
export const timesheetBudgetTypeSchema = z.enum(timesheetBudgetTypeEnum.enumValues);
export const timesheetRoundingRuleSchema = z.enum(timesheetRoundingRuleEnum.enumValues);
export const timesheetApprovalModeSchema = z.enum(timesheetApprovalModeEnum.enumValues);
export const timesheetPayPeriodSchema = z.enum(timesheetPayPeriodEnum.enumValues);

export const timesheetApprovalQueueStatusSchema = z.enum(["SUBMITTED", "APPROVED", "REJECTED"]);

export const timesheetExceptionStatusSchema = z.enum(["OPEN", "RESOLVED", "DISMISSED"]);
export const timesheetExceptionSeveritySchema = z.enum(["WARNING", "ERROR"]);

export type TimesheetExceptionStatus = z.infer<typeof timesheetExceptionStatusSchema>;
export type TimesheetExceptionSeverity = z.infer<typeof timesheetExceptionSeveritySchema>;

export type TimesheetEntryStatus = z.infer<typeof timesheetEntryStatusSchema>;
export type TimesheetPeriodStatus = z.infer<typeof timesheetPeriodStatusSchema>;
export type TimesheetBillingType = z.infer<typeof timesheetBillingTypeSchema>;
