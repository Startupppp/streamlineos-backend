import { randomUUID } from "crypto";

function nanoid(size = 8): string {
  return randomUUID().replace(/-/g, "").slice(0, size);
}

type AssigneeRole = "hr" | "manager" | "it" | "employee" | "buddy";

interface ChecklistItem {
  id: string;
  title: string;
  assigneeRole: AssigneeRole;
  dueOffsetDays: number;
  required: boolean;
  order: number;
}

interface ReviewQuestion {
  id: string;
  text: string;
  type: "rating" | "text" | "boolean";
  required: boolean;
}

interface ReviewSection {
  id: string;
  title: string;
  questions: ReviewQuestion[];
}

interface SurveyQuestion {
  id: string;
  text: string;
  type: "rating" | "text" | "boolean" | "multiple_choice";
  options?: string[];
  required: boolean;
  order: number;
}

type TemplateKind =
  | "onboarding_checklist"
  | "offboarding_checklist"
  | "probation_review"
  | "performance_review"
  | "goal"
  | "letter"
  | "document_request"
  | "email"
  | "notification"
  | "survey"
  | "training"
  | "asset_assignment"
  | "exit_interview";

type LetterType =
  | "offer"
  | "appointment"
  | "confirmation"
  | "promotion"
  | "transfer"
  | "salary_revision"
  | "warning"
  | "experience"
  | "relieving"
  | "termination";

interface DefaultTemplate {
  kind: TemplateKind;
  name: string;
  description: string;
  letterType?: LetterType;
  content: Record<string, unknown>;
  variablesUsed: string[];
}

function item(title: string, role: AssigneeRole, days: number, order: number, required = true): ChecklistItem {
  return { id: nanoid(8), title, assigneeRole: role, dueOffsetDays: days, required, order };
}

function q(text: string, type: ReviewQuestion["type"], required = true): ReviewQuestion {
  return { id: nanoid(8), text, type, required };
}

function section(title: string, questions: ReviewQuestion[]): ReviewSection {
  return { id: nanoid(8), title, questions };
}

function sq(text: string, type: SurveyQuestion["type"], order: number, options?: string[]): SurveyQuestion {
  return { id: nanoid(8), text, type, order, required: true, options };
}

export function buildDefaultTemplates(): DefaultTemplate[] {
  return [
    {
      kind: "onboarding_checklist",
      name: "Standard Onboarding Checklist",
      description: "Default checklist for all new joiners covering IT setup, documentation, and orientation.",
      content: {
        items: [
          item("Send welcome email with first-day instructions", "hr", -3, 0),
          item("Create user accounts (email, HRMS)", "it", 0, 1),
          item("Set up laptop and required software", "it", 0, 2),
          item("Assign buddy / onboarding partner", "hr", 0, 3),
          item("Complete personal information form", "employee", 1, 4),
          item("Submit bank account details", "employee", 2, 5),
          item("Upload required documents (ID, address proof)", "employee", 3, 6),
          item("Sign and return offer/appointment letter", "employee", 1, 7),
          item("Complete HR orientation session", "hr", 1, 8),
          item("Complete IT security training", "it", 3, 9),
          item("Meet with manager to discuss role expectations", "manager", 2, 10),
          item("Review employee handbook", "employee", 5, 11, false),
        ],
      },
      variablesUsed: ["employee.fullName", "company.name", "department.name", "manager.fullName"],
    },
    {
      kind: "offboarding_checklist",
      name: "Standard Offboarding Checklist",
      description: "Default checklist for all exiting employees.",
      content: {
        items: [
          item("Collect resignation letter", "hr", 0, 0),
          item("Initiate exit interview scheduling", "hr", 0, 1),
          item("Revoke access to all systems (email, HRMS)", "it", 0, 2),
          item("Collect company laptop and assets", "it", 0, 3),
          item("Settle outstanding expense claims", "hr", 3, 4),
          item("Process final settlement (FNF)", "hr", 7, 5),
          item("Issue experience/relieving letter", "hr", 7, 6),
          item("Update org chart and reporting structure", "manager", 0, 7),
          item("Hand over pending work and documentation", "employee", 0, 8, false),
        ],
      },
      variablesUsed: ["employee.fullName", "employee.lastWorkingDay", "company.name"],
    },
    {
      kind: "probation_review",
      name: "Probation Review Template",
      description: "90/180-day probation performance assessment.",
      content: {
        sections: [
          section("Performance Against Goals", [
            q("Has the employee met the goals set during onboarding?", "rating"),
            q("Describe key achievements during the probation period.", "text"),
          ]),
          section("Core Competencies", [
            q("Technical skills proficiency (1–5)", "rating"),
            q("Communication and collaboration (1–5)", "rating"),
            q("Punctuality and reliability (1–5)", "rating"),
          ]),
          section("Overall Assessment", [
            q("Do you recommend confirming this employee?", "boolean"),
            q("Additional notes or areas of improvement.", "text", false),
          ]),
        ],
      },
      variablesUsed: ["employee.fullName", "manager.fullName", "employee.joiningDate"],
    },
    {
      kind: "performance_review",
      name: "Annual Performance Review",
      description: "Annual review covering OKRs, competencies, and development plan.",
      content: {
        sections: [
          section("Goal Achievement", [
            q("Rate the employee's overall goal achievement (1–5)", "rating"),
            q("List goals achieved this cycle.", "text"),
            q("List goals missed and reasons.", "text", false),
          ]),
          section("Behavioural Competencies", [
            q("Teamwork and collaboration (1–5)", "rating"),
            q("Problem solving and initiative (1–5)", "rating"),
            q("Customer / stakeholder focus (1–5)", "rating"),
          ]),
          section("Development & Growth", [
            q("Key strengths observed this year.", "text"),
            q("Development areas for next year.", "text"),
            q("Proposed training or mentoring plan.", "text", false),
          ]),
        ],
      },
      variablesUsed: ["employee.fullName", "manager.fullName", "company.name"],
    },
    {
      kind: "exit_interview",
      name: "Exit Interview Survey",
      description: "Standard exit interview questions for voluntary exits.",
      content: {
        questions: [
          sq("What is your primary reason for leaving?", "multiple_choice", 0, [
            "Better opportunity", "Compensation", "Work-life balance", "Relationship with manager",
            "Culture fit", "Relocation", "Personal reasons", "Other",
          ]),
          sq("How satisfied were you with your role and responsibilities?", "rating", 1),
          sq("How would you rate your experience with your manager?", "rating", 2),
          sq("How would you rate team collaboration and work culture?", "rating", 3),
          sq("Would you recommend this company to others?", "boolean", 4),
          sq("What could we have done differently to retain you?", "text", 5),
          sq("Any other feedback you would like to share?", "text", 6),
        ],
      },
      variablesUsed: ["employee.fullName", "company.name"],
    },
    {
      kind: "letter",
      letterType: "offer",
      name: "Offer Letter",
      description: "Standard offer letter for new joiners.",
      content: {
        subject: "Offer of Employment — {{role.title}} at {{company.name}}",
        bodyHtml: `<div style="font-family:'Times New Roman',serif;max-width:700px;margin:0 auto;padding:40px;line-height:1.8">
<p style="text-align:right">Date: {{today}}</p>
<p>To,<br/><strong>{{employee.fullName}}</strong></p>
<p><strong>Subject: Offer of Employment — {{role.title}}</strong></p>
<p>Dear {{employee.firstName}},</p>
<p>We are pleased to offer you the position of <strong>{{role.title}}</strong> at <strong>{{company.name}}</strong>, in the <strong>{{department.name}}</strong> department, reporting to <strong>{{manager.fullName}}</strong>.</p>
<h3>Terms of Employment</h3>
<ul>
<li><strong>Date of Joining:</strong> {{effectiveDate}}</li>
<li><strong>Annual CTC:</strong> {{salary.ctc}}</li>
<li><strong>Probation Period:</strong> {{policy.probationDays}} days</li>
<li><strong>Notice Period:</strong> {{policy.noticePeriodDays}} days</li>
<li><strong>Location:</strong> {{location.name}}</li>
</ul>
<p>Please sign and return a copy of this letter as acceptance. If you have any questions, please contact <a href="mailto:{{company.hrEmail}}">{{company.hrEmail}}</a>.</p>
<p>We look forward to welcoming you to the team!</p>
<p style="margin-top:40px">Sincerely,<br/><strong>HR Department</strong><br/>{{company.name}}</p>
</div>`,
      },
      variablesUsed: ["employee.fullName", "employee.firstName", "role.title", "company.name", "department.name", "manager.fullName", "effectiveDate", "salary.ctc", "policy.probationDays", "policy.noticePeriodDays", "location.name", "company.hrEmail", "today"],
    },
    {
      kind: "letter",
      letterType: "appointment",
      name: "Appointment Letter",
      description: "Appointment letter issued after joining.",
      content: {
        subject: "Appointment Letter — {{employee.fullName}}",
        bodyHtml: `<div style="font-family:'Times New Roman',serif;max-width:700px;margin:0 auto;padding:40px;line-height:1.8">
<p style="text-align:right">Date: {{today}}</p>
<p>To,<br/><strong>{{employee.fullName}}</strong><br/>Employee No.: {{employee.employeeNumber}}</p>
<p><strong>Subject: Letter of Appointment</strong></p>
<p>Dear {{employee.firstName}},</p>
<p>We are pleased to appoint you as <strong>{{role.title}}</strong> in the <strong>{{department.name}}</strong> department of <strong>{{company.name}}</strong> effective <strong>{{employee.joiningDate}}</strong>.</p>
<p>You will report to <strong>{{manager.fullName}}</strong>. The terms and conditions of your employment are as outlined in your offer letter and the employee handbook.</p>
<p>We wish you a successful and rewarding career with us.</p>
<p style="margin-top:40px">Sincerely,<br/><strong>HR Department</strong><br/>{{company.name}}</p>
</div>`,
      },
      variablesUsed: ["employee.fullName", "employee.firstName", "employee.employeeNumber", "employee.joiningDate", "role.title", "department.name", "company.name", "manager.fullName", "today"],
    },
    {
      kind: "letter",
      letterType: "confirmation",
      name: "Confirmation Letter",
      description: "Confirmation of employment after successful probation.",
      content: {
        subject: "Confirmation of Employment — {{employee.fullName}}",
        bodyHtml: `<div style="font-family:'Times New Roman',serif;max-width:700px;margin:0 auto;padding:40px;line-height:1.8">
<p style="text-align:right">Date: {{today}}</p>
<p>To,<br/><strong>{{employee.fullName}}</strong></p>
<p><strong>Subject: Confirmation of Employment</strong></p>
<p>Dear {{employee.firstName}},</p>
<p>We are pleased to inform you that your employment with <strong>{{company.name}}</strong> as <strong>{{role.title}}</strong> has been confirmed with effect from <strong>{{effectiveDate}}</strong>, following the successful completion of your probation period.</p>
<p>All other terms and conditions of your employment remain unchanged.</p>
<p>Congratulations and we look forward to your continued contributions!</p>
<p style="margin-top:40px">Sincerely,<br/><strong>HR Department</strong><br/>{{company.name}}</p>
</div>`,
      },
      variablesUsed: ["employee.fullName", "employee.firstName", "role.title", "company.name", "effectiveDate", "today"],
    },
    {
      kind: "letter",
      letterType: "experience",
      name: "Experience Letter",
      description: "Experience certificate for employees who have left the organization.",
      content: {
        subject: "Experience Certificate — {{employee.fullName}}",
        bodyHtml: `<div style="font-family:'Times New Roman',serif;max-width:700px;margin:0 auto;padding:40px;line-height:1.8">
<p style="text-align:right">Date: {{today}}</p>
<p><strong>To Whom It May Concern</strong></p>
<p>This is to certify that <strong>{{employee.fullName}}</strong> was employed with <strong>{{company.name}}</strong> from <strong>{{employee.joiningDate}}</strong> to <strong>{{employee.lastWorkingDay}}</strong> as <strong>{{role.title}}</strong> in the <strong>{{department.name}}</strong> department.</p>
<p>During their tenure, {{employee.firstName}} demonstrated professionalism, dedication, and a strong work ethic, and consistently delivered quality work.</p>
<p>We wish {{employee.firstName}} all the best in their future endeavors.</p>
<p style="margin-top:40px">Sincerely,<br/><strong>HR Department</strong><br/>{{company.name}}</p>
</div>`,
      },
      variablesUsed: ["employee.fullName", "employee.firstName", "employee.joiningDate", "employee.lastWorkingDay", "role.title", "department.name", "company.name", "today"],
    },
    {
      kind: "letter",
      letterType: "experience",
      name: "Internship Certificate",
      description: "Certificate issued to interns on completion of their internship.",
      content: {
        subject: "Internship Completion Certificate — {{employee.fullName}}",
        bodyHtml: `<div style="font-family:'Times New Roman',serif;max-width:700px;margin:0 auto;padding:40px;line-height:1.8">
<p style="text-align:right">Date: {{today}}</p>
<p><strong>To Whom It May Concern</strong></p>
<p>This is to certify that <strong>{{employee.fullName}}</strong> successfully completed an internship with <strong>{{company.name}}</strong> from <strong>{{employee.joiningDate}}</strong> to <strong>{{employee.lastWorkingDay}}</strong> in the <strong>{{department.name}}</strong> department.</p>
<p>During the internship, {{employee.firstName}} worked diligently, showed a strong willingness to learn, and made valuable contributions to the team.</p>
<p>We wish {{employee.firstName}} continued success in their academic and professional journey.</p>
<p style="margin-top:40px">Sincerely,<br/><strong>HR Department</strong><br/>{{company.name}}</p>
</div>`,
      },
      variablesUsed: ["employee.fullName", "employee.firstName", "employee.joiningDate", "employee.lastWorkingDay", "department.name", "company.name", "today"],
    },
    {
      kind: "letter",
      letterType: "relieving",
      name: "Relieving Letter",
      description: "Relieving letter confirming employee has been relieved of all duties.",
      content: {
        subject: "Relieving Letter — {{employee.fullName}}",
        bodyHtml: `<div style="font-family:'Times New Roman',serif;max-width:700px;margin:0 auto;padding:40px;line-height:1.8">
<p style="text-align:right">Date: {{today}}</p>
<p>To,<br/><strong>{{employee.fullName}}</strong></p>
<p><strong>Subject: Relieving Letter</strong></p>
<p>Dear {{employee.firstName}},</p>
<p>This is to confirm that <strong>{{employee.fullName}}</strong>, holding the position of <strong>{{role.title}}</strong> in the <strong>{{department.name}}</strong> department, has been relieved from services with <strong>{{company.name}}</strong> with effect from <strong>{{employee.lastWorkingDay}}</strong>.</p>
<p>We confirm that all company property has been returned and dues have been settled. {{employee.firstName}} is relieved from all responsibilities and is free to seek employment elsewhere.</p>
<p>We thank {{employee.firstName}} for their contributions and wish them success in their future endeavors.</p>
<p style="margin-top:40px">Sincerely,<br/><strong>HR Department</strong><br/>{{company.name}}</p>
</div>`,
      },
      variablesUsed: ["employee.fullName", "employee.firstName", "employee.lastWorkingDay", "role.title", "department.name", "company.name", "today"],
    },
    {
      kind: "email",
      name: "Welcome Email",
      description: "Welcome email sent to new joiners on their first day.",
      content: {
        subject: "Welcome to {{company.name}}, {{employee.firstName}}!",
        bodyHtml: `<p>Dear {{employee.firstName}},</p>
<p>Welcome to <strong>{{company.name}}</strong>! We are thrilled to have you join us as <strong>{{role.title}}</strong> in the <strong>{{department.name}}</strong> department.</p>
<p>Your manager <strong>{{manager.fullName}}</strong> will be in touch to help you get settled in. In the meantime, here are a few things to get you started:</p>
<ul>
<li>Log in to the HRMS portal to complete your profile</li>
<li>Review the employee handbook</li>
<li>Set up your work email signature</li>
</ul>
<p>If you have any questions, reach out to us at <a href="mailto:{{company.hrEmail}}">{{company.hrEmail}}</a>.</p>
<p>Looking forward to working with you!</p>
<p>Warm regards,<br/><strong>HR Team</strong><br/>{{company.name}}</p>`,
      },
      variablesUsed: ["employee.firstName", "role.title", "department.name", "company.name", "manager.fullName", "company.hrEmail"],
    },
  ];
}
