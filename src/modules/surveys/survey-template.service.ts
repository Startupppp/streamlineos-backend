import { Injectable } from "@nestjs/common";

export interface SurveyTemplateDefinition {
  key: string;
  name: string;
  description: string;
  mode: "survey" | "assessment" | "live_session" | "lead_qualification" | "custom";
  category: string;
  sections: Array<{
    title: string;
    questions: Array<{
      type: string;
      title: string;
      required?: boolean;
      variableName?: string;
      settings?: Record<string, unknown>;
      choices?: Array<{ choiceKey: string; label: string; value?: string; score?: number; isCorrect?: boolean }>;
    }>;
  }>;
}

const BLANK_TEMPLATES: SurveyTemplateDefinition[] = [
  {
    key: "blank_survey",
    name: "Survey",
    description: "Gather feedback from customers, employees, users, event attendees, or partners.",
    mode: "survey",
    category: "General",
    sections: [{ title: "Section 1", questions: [] }],
  },
  {
    key: "blank_assessment",
    name: "Assessment",
    description: "Quiz, test, certification, scoring, pass/fail, training checks.",
    mode: "assessment",
    category: "General",
    sections: [{ title: "Section 1", questions: [] }],
  },
  {
    key: "blank_live_session",
    name: "Live Session",
    description: "Host-controlled real-time questions for presentations, classrooms, town halls, and webinars.",
    mode: "live_session",
    category: "General",
    sections: [{ title: "Section 1", questions: [] }],
  },
  {
    key: "blank_lead_qualification",
    name: "Lead Qualification",
    description: "Score respondents and create/route leads when key answers are chosen.",
    mode: "lead_qualification",
    category: "General",
    sections: [{ title: "Section 1", questions: [] }],
  },
];

const LIBRARY_TEMPLATES: SurveyTemplateDefinition[] = [
  {
    key: "customer_satisfaction",
    name: "Customer Satisfaction (CSAT)",
    description: "Measure how satisfied customers are with a recent purchase, order, or interaction.",
    mode: "survey",
    category: "Customer",
    sections: [
      {
        title: "Satisfaction",
        questions: [
          {
            type: "rating",
            title: "How satisfied are you with your recent experience?",
            required: true,
            variableName: "csat_score",
            settings: { min: 1, max: 5 },
          },
          {
            type: "single_select",
            title: "What could we improve?",
            choices: [
              { choiceKey: "product_quality", label: "Product quality" },
              { choiceKey: "pricing", label: "Pricing" },
              { choiceKey: "customer_service", label: "Customer service" },
              { choiceKey: "delivery_speed", label: "Delivery speed" },
              { choiceKey: "other", label: "Other" },
            ],
          },
          { type: "long_text", title: "Any additional comments?" },
        ],
      },
    ],
  },
  {
    key: "nps",
    name: "Net Promoter Score (NPS)",
    description: "The classic 0-10 recommendation question, with a one-click follow-up.",
    mode: "survey",
    category: "Customer",
    sections: [
      {
        title: "Recommendation",
        questions: [
          {
            type: "nps",
            title: "How likely are you to recommend us to a friend or colleague?",
            required: true,
            variableName: "nps_score",
          },
          { type: "long_text", title: "What's the primary reason for your score?" },
        ],
      },
    ],
  },
  {
    key: "product_feedback",
    name: "Product Feedback",
    description: "Understand how customers use your product and what to build next.",
    mode: "survey",
    category: "Product",
    sections: [
      {
        title: "Feedback",
        questions: [
          { type: "star_rating", title: "How would you rate our product overall?", required: true },
          {
            type: "multi_select",
            title: "Which features do you use most?",
            choices: [
              { choiceKey: "dashboard", label: "Dashboard" },
              { choiceKey: "reporting", label: "Reporting" },
              { choiceKey: "integrations", label: "Integrations" },
              { choiceKey: "mobile_app", label: "Mobile app" },
              { choiceKey: "automation", label: "Automation" },
            ],
          },
          { type: "long_text", title: "What feature would you like to see next?" },
        ],
      },
    ],
  },
  {
    key: "event_feedback",
    name: "Event Feedback",
    description: "Collect attendee feedback after a conference, webinar, or meetup.",
    mode: "survey",
    category: "Events",
    sections: [
      {
        title: "Your experience",
        questions: [
          { type: "star_rating", title: "How would you rate this event overall?", required: true },
          {
            type: "single_select",
            title: "How did you hear about this event?",
            choices: [
              { choiceKey: "social_media", label: "Social media" },
              { choiceKey: "email", label: "Email invite" },
              { choiceKey: "colleague", label: "A colleague" },
              { choiceKey: "website", label: "Our website" },
              { choiceKey: "other", label: "Other" },
            ],
          },
          { type: "yes_no", title: "Would you attend a future event like this?" },
          { type: "long_text", title: "Any suggestions for improvement?" },
        ],
      },
    ],
  },
  {
    key: "employee_pulse",
    name: "Employee Pulse Check",
    description: "A short, recurring check-in on team morale, workload, and engagement.",
    mode: "survey",
    category: "HR",
    sections: [
      {
        title: "Pulse check",
        questions: [
          { type: "likert", title: "I feel motivated to do my best work here." },
          { type: "likert", title: "I have the resources and support I need to do my job well." },
          { type: "rating", title: "How would you rate your current work-life balance?" },
          { type: "long_text", title: "What's one thing we could do to improve your experience?" },
        ],
      },
    ],
  },
  {
    key: "enps",
    name: "Employee NPS (eNPS)",
    description: "Measure how likely employees are to recommend your company as a place to work.",
    mode: "survey",
    category: "HR",
    sections: [
      {
        title: "Recommendation",
        questions: [
          {
            type: "nps",
            title: "How likely are you to recommend this company as a place to work?",
            required: true,
            variableName: "enps_score",
          },
          { type: "long_text", title: "What's the primary reason for your score?" },
        ],
      },
    ],
  },
  {
    key: "360_feedback",
    name: "360 Feedback",
    description: "Structured peer/manager feedback across communication, teamwork, and leadership.",
    mode: "survey",
    category: "HR",
    sections: [
      {
        title: "Ratings",
        questions: [
          { type: "rating", title: "Communication skills" },
          { type: "rating", title: "Collaboration & teamwork" },
          { type: "rating", title: "Leadership & initiative" },
        ],
      },
      {
        title: "Open feedback",
        questions: [
          { type: "long_text", title: "What are this person's key strengths?" },
          { type: "long_text", title: "What's one area they could focus on for growth?" },
        ],
      },
    ],
  },
  {
    key: "exit_interview",
    name: "Exit Interview",
    description: "Understand why an employee is leaving and what could have changed that.",
    mode: "survey",
    category: "HR",
    sections: [
      {
        title: "Departure",
        questions: [
          {
            type: "single_select",
            title: "What is your primary reason for leaving?",
            required: true,
            choices: [
              { choiceKey: "compensation", label: "Compensation" },
              { choiceKey: "career_growth", label: "Career growth" },
              { choiceKey: "management", label: "Management" },
              { choiceKey: "work_life_balance", label: "Work-life balance" },
              { choiceKey: "relocation", label: "Relocation" },
              { choiceKey: "other", label: "Other" },
            ],
          },
          { type: "rating", title: "Overall, how satisfied were you working here?" },
          { type: "yes_no", title: "Would you consider working here again in the future?" },
          { type: "long_text", title: "What could we have done differently to keep you?" },
        ],
      },
    ],
  },
  {
    key: "course_evaluation",
    name: "Course Evaluation",
    description: "Gather student feedback on course content, pacing, and instruction quality.",
    mode: "survey",
    category: "Education",
    sections: [
      {
        title: "Evaluation",
        questions: [
          { type: "star_rating", title: "How would you rate this course overall?", required: true },
          { type: "likert", title: "The course content was well-organized." },
          { type: "likert", title: "The instructor communicated clearly." },
          { type: "long_text", title: "What could be improved?" },
        ],
      },
    ],
  },
  {
    key: "certification_quiz",
    name: "Certification Quiz",
    description: "A scored, pass/fail quiz for certifying knowledge or completing training.",
    mode: "assessment",
    category: "Education",
    sections: [
      {
        title: "Quiz",
        questions: [
          {
            type: "single_select",
            title: "What does HTTP stand for?",
            required: true,
            choices: [
              { choiceKey: "a", label: "HyperText Transfer Protocol", score: 100, isCorrect: true },
              { choiceKey: "b", label: "High Transfer Text Protocol", score: 0 },
              { choiceKey: "c", label: "Home Tool Transfer Protocol", score: 0 },
              { choiceKey: "d", label: "Hyperlink Text Transport Protocol", score: 0 },
            ],
          },
          {
            type: "single_select",
            title: "Which HTTP method is used to retrieve data without side effects?",
            required: true,
            choices: [
              { choiceKey: "a", label: "GET", score: 100, isCorrect: true },
              { choiceKey: "b", label: "POST", score: 0 },
              { choiceKey: "c", label: "DELETE", score: 0 },
              { choiceKey: "d", label: "PATCH", score: 0 },
            ],
          },
          {
            type: "single_select",
            title: "What status code indicates a successful request?",
            required: true,
            choices: [
              { choiceKey: "a", label: "200", score: 100, isCorrect: true },
              { choiceKey: "b", label: "301", score: 0 },
              { choiceKey: "c", label: "404", score: 0 },
              { choiceKey: "d", label: "500", score: 0 },
            ],
          },
        ],
      },
    ],
  },
  {
    key: "lead_qualification_bant",
    name: "Lead Qualification (BANT)",
    description: "Score inbound leads on budget and timeline, and route qualified ones to sales.",
    mode: "lead_qualification",
    category: "Sales",
    sections: [
      {
        title: "About you",
        questions: [
          { type: "short_text", title: "What's your name?", variableName: "name" },
          { type: "email", title: "What's your work email?", required: true, variableName: "email" },
        ],
      },
      {
        title: "Qualification",
        questions: [
          {
            type: "single_select",
            title: "What's your budget range?",
            variableName: "budget",
            choices: [
              { choiceKey: "under_1k", label: "Under $1,000", score: 0 },
              { choiceKey: "1k_10k", label: "$1,000 - $10,000", score: 40 },
              { choiceKey: "over_10k", label: "$10,000+", score: 100 },
            ],
          },
          {
            type: "single_select",
            title: "How soon are you looking to get started?",
            variableName: "timeline",
            choices: [
              { choiceKey: "researching", label: "Just researching", score: 0 },
              { choiceKey: "3_months", label: "Within 3 months", score: 50 },
              { choiceKey: "immediately", label: "Immediately", score: 100 },
            ],
          },
        ],
      },
    ],
  },
  {
    key: "demo_request",
    name: "Demo Request",
    description: "Capture company details from prospects requesting a product demo.",
    mode: "lead_qualification",
    category: "Sales",
    sections: [
      {
        title: "Request a demo",
        questions: [
          { type: "short_text", title: "Full name", required: true, variableName: "name" },
          { type: "email", title: "Work email", required: true, variableName: "email" },
          { type: "short_text", title: "Company name", variableName: "company" },
          {
            type: "single_select",
            title: "Company size",
            variableName: "company_size",
            choices: [
              { choiceKey: "1_10", label: "1-10 employees", score: 10 },
              { choiceKey: "11_50", label: "11-50 employees", score: 40 },
              { choiceKey: "51_200", label: "51-200 employees", score: 70 },
              { choiceKey: "200_plus", label: "200+ employees", score: 100 },
            ],
          },
          { type: "long_text", title: "What are you hoping to solve?" },
        ],
      },
    ],
  },
  {
    key: "website_feedback",
    name: "Website Feedback",
    description: "A lightweight on-site widget survey to understand visitor experience.",
    mode: "survey",
    category: "Product",
    sections: [
      {
        title: "Your visit",
        questions: [
          { type: "rating", title: "How easy was it to find what you were looking for?", required: true },
          {
            type: "single_select",
            title: "What best describes your visit today?",
            choices: [
              { choiceKey: "researching", label: "Just researching" },
              { choiceKey: "ready_to_buy", label: "Ready to buy" },
              { choiceKey: "support", label: "Looking for support" },
              { choiceKey: "other", label: "Other" },
            ],
          },
          { type: "long_text", title: "Any feedback on how we can improve the site?" },
        ],
      },
    ],
  },
  {
    key: "support_csat",
    name: "Support Ticket CSAT",
    description: "Sent after a support ticket closes to measure resolution quality.",
    mode: "survey",
    category: "Support",
    sections: [
      {
        title: "Your support experience",
        questions: [
          { type: "star_rating", title: "How satisfied were you with the support you received?", required: true },
          { type: "yes_no", title: "Was your issue resolved?" },
          {
            type: "single_select",
            title: "How would you rate the response time?",
            choices: [
              { choiceKey: "very_fast", label: "Very fast" },
              { choiceKey: "fast", label: "Fast" },
              { choiceKey: "average", label: "Average" },
              { choiceKey: "slow", label: "Slow" },
            ],
          },
          { type: "long_text", title: "Any additional feedback?" },
        ],
      },
    ],
  },
];

const ALL_TEMPLATES: SurveyTemplateDefinition[] = [...BLANK_TEMPLATES, ...LIBRARY_TEMPLATES];

@Injectable()
export class SurveyTemplateService {
  list(): SurveyTemplateDefinition[] {
    return ALL_TEMPLATES;
  }

  get(key: string): SurveyTemplateDefinition | undefined {
    return ALL_TEMPLATES.find((t) => t.key === key);
  }
}
