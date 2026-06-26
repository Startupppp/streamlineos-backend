export interface ResignationLetterData {
  employeeName: string;
  designation: string;
  department: string | null;
  joiningDate: string;
  date: string;
  reason: string;
  reasonCategory: string;
  lastWorkingDate: string;
  companyName: string;
}

export function generateResignationLetter(data: ResignationLetterData): string {
  return `
<div style="font-family: 'Times New Roman', serif; max-width: 700px; margin: 0 auto; padding: 40px; line-height: 1.8;">
  <p style="text-align: right; margin-bottom: 30px;">Date: ${data.date}</p>

  <p>To,<br/>
  The HR Manager,<br/>
  ${data.companyName}</p>

  <p><strong>Subject: Resignation from the position of ${data.designation}</strong></p>

  <p>Dear Sir/Madam,</p>

  <p>I, <strong>${data.employeeName}</strong>, holding the position of <strong>${data.designation}</strong>${data.department ? ` in the <strong>${data.department}</strong> department` : ""}, having joined on <strong>${data.joiningDate}</strong>, hereby tender my resignation from my position at <strong>${data.companyName}</strong>.</p>

  <p><strong>Reason for Resignation:</strong> ${data.reasonCategory}${data.reason ? ` — ${data.reason}` : ""}</p>

  <p>As per the company's notice period policy, my last working date will be <strong>${data.lastWorkingDate}</strong>. I am committed to ensuring a smooth transition during this period and will complete all pending tasks and hand over my responsibilities.</p>

  <p>I would like to express my sincere gratitude for the opportunities, support, and growth I have experienced during my tenure at ${data.companyName}. I have greatly valued my time here and the relationships I have built with my colleagues.</p>

  <p>I request you to kindly accept my resignation and initiate the necessary formalities.</p>

  <p style="margin-top: 40px;">Sincerely,<br/>
  <strong>${data.employeeName}</strong><br/>
  ${data.designation}</p>
</div>`.trim();
}

export interface TerminationLetterHtmlData {
  employeeName: string;
  designation: string;
  companyName: string;
  reasons: string[];
  effectiveDate: string;
  severanceAmount: string | null;
  date: string;
}

export function generateTerminationLetterHtml(data: TerminationLetterHtmlData): string {
  const reasonsList = data.reasons.map((r) => `<li>${r}</li>`).join("\n");

  return `
<div style="font-family: 'Times New Roman', serif; max-width: 700px; margin: 0 auto; padding: 40px; line-height: 1.8;">
  <div style="text-align: center; margin-bottom: 30px; border-bottom: 2px solid #333; padding-bottom: 15px;">
    <h2 style="margin: 0;">${data.companyName}</h2>
    <p style="margin: 5px 0 0; font-size: 12px; color: #666;">CONFIDENTIAL</p>
  </div>

  <p style="text-align: right;">Date: ${data.date}</p>

  <p>To,<br/>
  <strong>${data.employeeName}</strong><br/>
  ${data.designation}<br/>
  ${data.companyName}</p>

  <p><strong>Subject: Termination of Employment</strong></p>

  <p>Dear ${data.employeeName},</p>

  <p>This letter is to formally notify you that your employment with <strong>${data.companyName}</strong> is being terminated, effective <strong>${data.effectiveDate}</strong>.</p>

  <p><strong>Reason(s) for Termination:</strong></p>
  <ul>${reasonsList}</ul>

  ${data.severanceAmount ? `<p><strong>Severance:</strong> You will receive a severance payment of <strong>INR ${data.severanceAmount}</strong>, subject to applicable deductions and taxes. This amount will be included in your final settlement.</p>` : ""}

  <p><strong>Final Settlement:</strong> Your final settlement, including any pending salary, leave encashment, and other dues, will be processed within 45 days from the effective date of termination.</p>

  <p><strong>Return of Company Property:</strong> You are requested to hand over all company assets, documents, and responsibilities to <strong>Reporting Manager/HR</strong> on your last working day.</p>

  <p><strong>Confidentiality:</strong> All confidentiality and non-disclosure agreements remain in full effect even after termination.</p>

  <p>We wish you the best in your future endeavours.</p>

  <p style="margin-top: 40px;">
  Sincerely,<br/><br/>
  <strong>Human Resources Department</strong><br/>
  ${data.companyName}
  </p>

  <p style="margin-top: 20px; font-size: 11px; color: #999; text-align: center;">
    For queries, please contact HR at <a href="mailto:hr@streamlineos.app">hr@streamlineos.app</a>
  </p>
</div>`.trim();
}

export interface ExperienceLetterData {
  name: string;
  joiningDate: string;
  relievingDate: string;
  designation: string;
  role: string;
}

export function buildExperienceLetterContent(data: ExperienceLetterData) {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Experience Certificate" }] },
      { type: "paragraph", content: [{ type: "text", text: `Date: ${new Date().toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}` }] },
      { type: "paragraph" },
      { type: "paragraph", content: [{ type: "text", text: "To Whom It May Concern," }] },
      { type: "paragraph", content: [{ type: "text", text: `This is to certify that ${data.name} was employed with our organization from ${data.joiningDate} to ${data.relievingDate} as ${data.designation}.` }] },
      { type: "paragraph", content: [{ type: "text", text: `During their tenure, ${data.name} demonstrated professionalism, dedication, and a strong work ethic. They were responsible for their duties in the ${data.role} department and consistently delivered quality work.` }] },
      { type: "paragraph", content: [{ type: "text", text: `We wish ${data.name} all the best in their future endeavors.` }] },
      { type: "paragraph" },
      { type: "paragraph", content: [{ type: "text", text: "Sincerely," }] },
      { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "HR Department" }] },
    ],
  };
}
