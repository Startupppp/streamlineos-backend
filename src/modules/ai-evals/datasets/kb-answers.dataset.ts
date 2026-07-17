export interface KbAnswerCase {
  name: string;
  question: string;
  contextChunks: string[];
  expectedGrounded: boolean;
  mustCiteFrom: string[];
  isUnsupported: boolean;
}

export const KB_ANSWERS_DATASET: readonly KbAnswerCase[] = [
  {
    name: "grounded-password-reset",
    question: "How do I reset my password?",
    contextChunks: [
      "To reset your password, go to Settings > Security > Change Password. Enter your current password and then your new password twice.",
      "Passwords must be at least 8 characters and include a number.",
    ],
    expectedGrounded: true,
    mustCiteFrom: ["Settings > Security > Change Password"],
    isUnsupported: false,
  },
  {
    name: "grounded-leave-policy",
    question: "How many vacation days do employees get per year?",
    contextChunks: [
      "Full-time employees are entitled to 20 vacation days per year. Part-time employees receive a prorated amount based on their FTE.",
    ],
    expectedGrounded: true,
    mustCiteFrom: ["20 vacation days"],
    isUnsupported: false,
  },
  {
    name: "grounded-expense-submission",
    question: "What is the deadline to submit expense reports?",
    contextChunks: [
      "Expense reports must be submitted within 30 days of the expense date. Late submissions require manager approval and may not be reimbursed.",
    ],
    expectedGrounded: true,
    mustCiteFrom: ["30 days"],
    isUnsupported: false,
  },
  {
    name: "grounded-multi-chunk",
    question: "What are the steps to onboard a new employee?",
    contextChunks: [
      "Step 1: HR creates the employee record in StreamlineOS and sends an invitation email.",
      "Step 2: The new employee completes the onboarding form with personal and bank details.",
      "Step 3: IT provisions the required software and access credentials.",
    ],
    expectedGrounded: true,
    mustCiteFrom: ["HR creates the employee record", "onboarding form", "IT provisions"],
    isUnsupported: false,
  },
  {
    name: "unsupported-no-context",
    question: "What is the company stock price today?",
    contextChunks: [],
    expectedGrounded: false,
    mustCiteFrom: [],
    isUnsupported: true,
  },
  {
    name: "unsupported-irrelevant-context",
    question: "How do I apply for a patent?",
    contextChunks: [
      "The leave policy covers annual, sick, and maternity/paternity leave.",
      "Expense reports are processed within 5-7 business days.",
    ],
    expectedGrounded: false,
    mustCiteFrom: [],
    isUnsupported: true,
  },
  {
    name: "partially-grounded-hallucination-risk",
    question: "What software does IT provide?",
    contextChunks: [
      "IT provisions access credentials and required software tools for new employees.",
    ],
    expectedGrounded: true,
    mustCiteFrom: ["access credentials", "software tools"],
    isUnsupported: false,
  },
  {
    name: "unsupported-empty-question-context-mismatch",
    question: "What is the CEO's salary?",
    contextChunks: [
      "The payroll module allows HR admins to manage employee compensation. Specific salary data is confidential.",
    ],
    expectedGrounded: false,
    mustCiteFrom: [],
    isUnsupported: true,
  },
] as const;
