import { escapeHtml } from "../templates/html-sanitizer";

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

/**
 * Every field is escaped: the reason and name are written by the resigning employee and the HR
 * admin opens the result as HTML in an app-origin window. Unescaped, a reason carrying a `<form>`
 * rendered a credential prompt that looked like the product's own (DOMPurify strips scripts,
 * not forms).
 */
export function generateResignationLetter(raw: ResignationLetterData): string {
  const data: ResignationLetterData = {
    employeeName: escapeHtml(raw.employeeName),
    designation: escapeHtml(raw.designation),
    department: raw.department === null ? null : escapeHtml(raw.department),
    joiningDate: escapeHtml(raw.joiningDate),
    date: escapeHtml(raw.date),
    reason: escapeHtml(raw.reason),
    reasonCategory: escapeHtml(raw.reasonCategory),
    lastWorkingDate: escapeHtml(raw.lastWorkingDate),
    companyName: escapeHtml(raw.companyName),
  };
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

