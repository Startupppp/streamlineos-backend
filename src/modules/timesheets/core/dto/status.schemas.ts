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

/**
 * TS-28. Every timesheet status enum, as Zod, derived from the database enum.
 *
 * The ticket asks for status enums enforced at write with the DB enum deferred,
 * and the obvious way to do that is to hand-write `z.enum([...])` beside each
 * DTO. Several of those already existed, and they were already a maintenance
 * hazard: the same six period statuses were spelled out in `periods.schemas.ts`
 * and again in the lifecycle event payload, the three entry statuses in
 * `entries.schemas.ts`, and nothing connected any of them to
 * `db/schema/timesheets/enums.ts`. Adding a value to a `pgEnum` therefore left
 * the Zod copies silently rejecting the new value at the edge — a 400 on a
 * status the database accepts, which reads as a bug in the caller.
 *
 * `pgEnum(...).enumValues` is a readonly tuple of string literals, so
 * `z.enum(...)` over it produces exactly the same type a hand-written literal
 * union would, with no way for the two to disagree. Drift stops being possible
 * rather than being caught by a test.
 *
 * These are for validating *input*. They are not a claim that every status is
 * reachable through the API — `LOCKED` is in the period enum and no code path
 * writes it (recorded as a finding on TS-05/TS-14) — only that a status which
 * arrives from a client is one the column can hold.
 */
export const timesheetEntryStatusSchema = z.enum(timesheetEntryStatusEnum.enumValues);
export const timesheetPeriodStatusSchema = z.enum(timesheetPeriodStatusEnum.enumValues);
export const timesheetBillingTypeSchema = z.enum(timesheetBillingTypeEnum.enumValues);
export const timesheetEntrySourceSchema = z.enum(timesheetEntrySourceEnum.enumValues);
export const timesheetBudgetStatusSchema = z.enum(timesheetBudgetStatusEnum.enumValues);
export const timesheetBudgetTypeSchema = z.enum(timesheetBudgetTypeEnum.enumValues);
export const timesheetRoundingRuleSchema = z.enum(timesheetRoundingRuleEnum.enumValues);
export const timesheetApprovalModeSchema = z.enum(timesheetApprovalModeEnum.enumValues);
export const timesheetPayPeriodSchema = z.enum(timesheetPayPeriodEnum.enumValues);

/**
 * The approval queue reads only the three statuses a period can be *in* when it
 * is somebody's decision to make. Narrower than the full period enum on
 * purpose: `?status=OPEN` on the approvals list would return periods nobody has
 * submitted, which is the overdue queue's job (TS-11), not this one's.
 */
export const timesheetApprovalQueueStatusSchema = z.enum(["SUBMITTED", "APPROVED", "REJECTED"]);

/**
 * `timesheet_exceptions.status` and `.severity` are plain `text` columns with
 * no Postgres enum behind them — the "DB enum deferred" half of the ticket,
 * literally. Zod is therefore the only thing standing between a client and an
 * arbitrary string in a column the exceptions queue filters on, so these two
 * are the ones that most need a single definition rather than a literal
 * repeated at each call site.
 */
export const timesheetExceptionStatusSchema = z.enum(["OPEN", "RESOLVED", "DISMISSED"]);
export const timesheetExceptionSeveritySchema = z.enum(["WARNING", "ERROR"]);

export type TimesheetExceptionStatus = z.infer<typeof timesheetExceptionStatusSchema>;
export type TimesheetExceptionSeverity = z.infer<typeof timesheetExceptionSeveritySchema>;

export type TimesheetEntryStatus = z.infer<typeof timesheetEntryStatusSchema>;
export type TimesheetPeriodStatus = z.infer<typeof timesheetPeriodStatusSchema>;
export type TimesheetBillingType = z.infer<typeof timesheetBillingTypeSchema>;
