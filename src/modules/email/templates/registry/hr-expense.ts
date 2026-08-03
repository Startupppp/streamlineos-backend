import {
  getExpenseSubmittedEmailTemplate,
  getExpenseApprovedEmailTemplate,
  getExpenseRejectedEmailTemplate,
  getExpensePaidEmailTemplate,
} from "../index";
import { BASE_URL } from "./_shared";
import type { TemplateEntry } from "./_shared";

export const hrExpenseTemplates: Record<string, TemplateEntry> = {
  "expense.submitted": {
    category: "HR Expense",
    name: "Expense Submitted",
    subject: "New expense claim from Priya Sharma",
    generateHtml: () =>
      getExpenseSubmittedEmailTemplate(
        "Rahul Verma",
        "Priya Sharma",
        "Travel",
        "1,500",
        "Mumbai to Pune cab",
        `${BASE_URL}/hr/expenses`,
      ),
  },
  "expense.approved": {
    category: "HR Expense",
    name: "Expense Approved",
    subject: "Your expense claim was approved",
    generateHtml: () => getExpenseApprovedEmailTemplate("Priya Sharma", "Travel", "1,500", "Rahul Verma"),
  },
  "expense.rejected": {
    category: "HR Expense",
    name: "Expense Rejected",
    subject: "Your expense claim was rejected",
    generateHtml: () =>
      getExpenseRejectedEmailTemplate("Priya Sharma", "Travel", "1,500", "Rahul Verma", "Receipt not attached."),
  },
  "expense.paid": {
    category: "HR Expense",
    name: "Expense Reimbursed",
    subject: "Your expense reimbursement was paid",
    generateHtml: () => getExpensePaidEmailTemplate("Priya Sharma", "Travel", "1,500", "TXN-TEST-001"),
  },
};
