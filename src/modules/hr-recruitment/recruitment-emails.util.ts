function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface RejectionEmailParams {
  candidateName: string;
  jobTitle: string;
  companyName: string;
  senderName?: string;
  notes?: string;
}

export function getCandidateRejectionEmail(params: RejectionEmailParams): { subject: string; html: string } {
  const candidateName = escapeHtml(params.candidateName);
  const jobTitle = escapeHtml(params.jobTitle);
  const companyName = escapeHtml(params.companyName);
  const senderName = params.senderName ? escapeHtml(params.senderName) : companyName;
  const notes = params.notes ? escapeHtml(params.notes) : null;

  const subject = `Update on your application — ${jobTitle} at ${companyName}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
      <div style="background: #0f2b7f; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: #fff; margin: 0; font-size: 20px;">${companyName}</h1>
      </div>
      <div style="padding: 24px; background: #fff; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <p>Dear ${candidateName},</p>
        <p>Thank you for your interest in the <strong>${jobTitle}</strong> role at <strong>${companyName}</strong>.</p>
        <p>After careful consideration, we regret to inform you that we will not be proceeding with your application at this time.</p>
        ${notes ? `<p style="color:#475569;">${notes}</p>` : ""}
        <p>We appreciate the time you invested and wish you all the best in your future endeavors.</p>
        <p>Kind regards,<br/><strong>${senderName}</strong><br/>${companyName}</p>
      </div>
    </div>
  `;

  return { subject, html };
}
