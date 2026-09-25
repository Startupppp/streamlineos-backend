import { eq, sql, type SQL } from "drizzle-orm";
import { users } from "../../../db/schema/common/auth";

/**
 * The one definition of "this person is active headcount" (HRMS-E2E-015).
 *
 * `users.is_active` is the ACCOUNT flag. An administrator creating a person
 * sets it true on the spot, before the invitation has been sent, let alone
 * opened. Filtering a headcount on it alone reported an invitation nobody ever
 * accepted as an employee who is here — which is the number a founder reads off
 * the dashboard.
 *
 * Acceptance is taken to be `users.email_verified` being non-null: the magic
 * link sets it the first time the person comes through it, and
 * `employee-onboarding.service.ts` already reads exactly that column to decide
 * between a welcome mail and a membership-added mail. Nothing is stored and
 * nothing is migrated — the split is computed at read time, so if product
 * decision #4 later says a joining date must also have passed, this is the one
 * expression that changes.
 *
 * This is the same predicate as the `active` bucket of
 * `EmployeesService.getEmployeeCounts`, which spells it as a `count(*) filter`
 * clause because it needs `pending` and `inactive` out of the same scan. Here
 * it is a WHERE condition, so `is_active` is compared rather than used as a
 * bare boolean. Kept parenthesised so it survives being nested under an `or`.
 *
 * Deliberately NOT applied to: the directory listing and org chart (a pending
 * joiner belongs on both — the directory reports them in their own bucket),
 * payroll input snapshots and the statutory compliance panel (those obligations
 * attach to a hire whether or not they opened their email), onboarding views
 * (pending people are the entire point of that screen), and notification
 * recipients.
 */
export function acceptedEmployee(): SQL {
  return sql`(${eq(users.isActive, true)} and ${users.emailVerified} is not null)`;
}
