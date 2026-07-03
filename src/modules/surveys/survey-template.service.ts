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

@Injectable()
export class SurveyTemplateService {
  list(): SurveyTemplateDefinition[] {
    return BLANK_TEMPLATES;
  }

  get(key: string): SurveyTemplateDefinition | undefined {
    return BLANK_TEMPLATES.find((t) => t.key === key);
  }
}
