import {
  IN_APP,
  IN_APP_EMAIL,
  URGENT_ALLOWED_CHANNELS,
} from "./notification-event-channel-policy";
import { notificationEvent } from "./notification-event-factory";

const e = notificationEvent;
const IA = IN_APP;
const IA_EMAIL = IN_APP_EMAIL;
const ALLOWED_URGENT = URGENT_ALLOWED_CHANNELS;

export const ACCOUNTING_NOTIFICATION_EVENTS = [
  e(
    "accounting.invoice.overdue",
    "accounting",
    "ACCOUNTING",
    "Invoice overdue",
    {
      defaultPriority: "HIGH",
      defaultType: "WARNING",
      defaultChannels: IA_EMAIL,
    },
  ),
  e(
    "accounting.invoice.payment_received",
    "accounting",
    "ACCOUNTING",
    "Invoice payment received",
    { defaultType: "SUCCESS", defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.invoice.recurring_generated",
    "accounting",
    "ACCOUNTING",
    "Recurring invoice generated",
    { defaultChannels: IA },
  ),
  e("accounting.bill.due", "accounting", "ACCOUNTING", "Bill due soon", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "accounting.bill.approval_requested",
    "accounting",
    "WORKFLOW",
    "Bill approval requested",
    { defaultPriority: "HIGH", defaultChannels: IA_EMAIL },
  ),
  e("accounting.bill.approved", "accounting", "ACCOUNTING", "Bill approved", {
    defaultType: "SUCCESS",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "accounting.bill.recurring_generated",
    "accounting",
    "ACCOUNTING",
    "Recurring bill generated",
    { defaultChannels: IA },
  ),
  e(
    "accounting.payment.recorded",
    "accounting",
    "ACCOUNTING",
    "Vendor payment recorded",
    { defaultType: "SUCCESS", defaultChannels: IA },
  ),
  e(
    "accounting.expense.submitted",
    "accounting",
    "WORKFLOW",
    "Expense submitted for approval",
    { defaultPriority: "HIGH", defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.expense.approved",
    "accounting",
    "ACCOUNTING",
    "Expense approved",
    { defaultType: "SUCCESS", defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.expense.rejected",
    "accounting",
    "ACCOUNTING",
    "Expense rejected",
    { defaultType: "WARNING", defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.reimbursement.paid",
    "accounting",
    "ACCOUNTING",
    "Expense reimbursement paid",
    { defaultType: "SUCCESS", defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.approval.requested",
    "accounting",
    "WORKFLOW",
    "Finance approval requested",
    { defaultPriority: "HIGH", defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.approval.decided",
    "accounting",
    "ACCOUNTING",
    "Finance approval decided",
    { defaultChannels: IA_EMAIL },
  ),
  e(
    "accounting.period.closed",
    "accounting",
    "ACCOUNTING",
    "Accounting period closed",
    { defaultChannels: IA },
  ),
  e(
    "accounting.period.reopened",
    "accounting",
    "ACCOUNTING",
    "Accounting period reopened",
    {
      defaultPriority: "HIGH",
      defaultType: "WARNING",
      defaultChannels: IA_EMAIL,
    },
  ),
  e(
    "accounting.reconciliation.mismatch",
    "accounting",
    "ACCOUNTING",
    "Bank reconciliation mismatch",
    {
      defaultPriority: "HIGH",
      defaultType: "WARNING",
      defaultChannels: IA_EMAIL,
    },
  ),
  e(
    "accounting.bank.import_completed",
    "accounting",
    "ACCOUNTING",
    "Bank import completed",
    { defaultType: "SUCCESS", defaultChannels: IA },
  ),
  e("accounting.tax.due", "accounting", "ACCOUNTING", "Tax payment due", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "accounting.tax.payment_posted",
    "accounting",
    "ACCOUNTING",
    "Tax payment posted",
    { defaultType: "SUCCESS", defaultChannels: IA },
  ),
  e(
    "accounting.budget.exceeded",
    "accounting",
    "ACCOUNTING",
    "Budget threshold exceeded",
    {
      defaultPriority: "HIGH",
      defaultType: "WARNING",
      defaultChannels: IA_EMAIL,
    },
  ),
  e(
    "accounting.depreciation.run_posted",
    "accounting",
    "ACCOUNTING",
    "Depreciation run posted",
    { defaultChannels: IA },
  ),
];
