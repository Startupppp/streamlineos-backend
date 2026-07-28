export interface SupportTicket {
  title: string;
  description: string;
}

export interface SupportSuggestionCase {
  name: string;
  ticket: SupportTicket;
  expectedCategory?: string;
  expectedConfidenceMin?: number;
  mustNotContainPII: boolean;
}

export const SUPPORT_SUGGESTIONS_DATASET: readonly SupportSuggestionCase[] = [
  {
    name: "leave-request",
    ticket: {
      title: "Cannot submit leave request",
      description: "When I click Submit on the leave form, nothing happens and there is no error shown.",
    },
    expectedCategory: "Leave",
    expectedConfidenceMin: 0.6,
    mustNotContainPII: true,
  },
  {
    name: "payroll-query",
    ticket: {
      title: "My payslip shows wrong amount",
      description: "My payslip for June shows $3200 but I should have received $3500 per my contract.",
    },
    expectedCategory: "Payroll",
    expectedConfidenceMin: 0.7,
    mustNotContainPII: false,
  },
  {
    name: "pii-in-description",
    ticket: {
      title: "Password reset issue",
      description: "User john.doe@company.com with phone 555-123-4567 and SSN 123-45-6789 cannot reset password.",
    },
    expectedCategory: "IT",
    expectedConfidenceMin: 0.5,
    mustNotContainPII: true,
  },
  {
    name: "benefits-question",
    ticket: {
      title: "Health insurance card not received",
      description: "I enrolled in the health insurance plan last month but still haven't received my insurance card.",
    },
    expectedCategory: "Benefits",
    expectedConfidenceMin: 0.6,
    mustNotContainPII: true,
  },
  {
    name: "it-access-request",
    ticket: {
      title: "Need access to project management tool",
      description: "I joined the team last week and still don't have access to the StreamlineOS PM module.",
    },
    expectedCategory: "IT",
    expectedConfidenceMin: 0.6,
    mustNotContainPII: true,
  },
  {
    name: "policy-question",
    ticket: {
      title: "Work from home policy clarification",
      description: "I'd like to understand the remote work policy — how many days per week can I work from home?",
    },
    expectedCategory: "Policy",
    expectedConfidenceMin: 0.5,
    mustNotContainPII: true,
  },
  {
    name: "pii-credit-card",
    ticket: {
      title: "Expense reimbursement delay",
      description: "I submitted my expense claim for card 4111 1111 1111 1111 but have not been reimbursed yet.",
    },
    expectedCategory: "Payroll",
    expectedConfidenceMin: 0.4,
    mustNotContainPII: true,
  },
  {
    name: "generic-other",
    ticket: {
      title: "General feedback",
      description: "The dashboard loads slowly on Monday mornings.",
    },
    expectedCategory: "Other",
    expectedConfidenceMin: 0.3,
    mustNotContainPII: true,
  },
] as const;
