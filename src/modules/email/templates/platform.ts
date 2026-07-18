import { getEmailTemplate, escapeHtml } from "./base";
import { renderKeyValueRows, renderCallout, renderButton } from "./components";

export interface ContactAdminEmailParams {
  name: string;
  email: string;
  topic: string;
  message: string;
  reference: string;
  receivedAt: string;
  company?: string;
  phone?: string;
  inboxUrl?: string;
}

export function getContactAdminNotificationEmail(params: ContactAdminEmailParams): { subject: string; html: string } {
  const { name, email, topic, message, reference, receivedAt, company, phone, inboxUrl } = params;
  const subject = `New ${topic} contact message`;

  const rows: Array<{ label: string; value: string }> = [
    { label: "Reference", value: reference },
    { label: "Name", value: name },
    { label: "Email", value: email },
  ];
  if (company) rows.push({ label: "Company", value: company });
  if (phone) rows.push({ label: "Phone", value: phone });
  rows.push({ label: "Topic", value: topic });
  rows.push({ label: "Received", value: receivedAt });

  const escapedMessage = escapeHtml(message).replace(/\n/g, "<br>");

  const content = `
<h1 class="email-title">${escapeHtml(subject)}</h1>
${renderKeyValueRows(rows)}
${renderCallout(escapedMessage, "info")}
${inboxUrl ? renderButton("Open inbox", inboxUrl) : ""}
`;
  return {
    subject,
    html: getEmailTemplate({
      title: subject,
      preheader: `${escapeHtml(name)} sent a ${escapeHtml(topic)} message via the contact form.`,
      content,
    }),
  };
}

export interface ContactAutoreplyEmailParams {
  name: string;
  message: string;
}

export function getContactAutoreplyEmail(params: ContactAutoreplyEmailParams): { subject: string; html: string } {
  const { name, message } = params;
  const subject = "We received your message";
  const firstName = escapeHtml(name.split(" ")[0] ?? name);
  const escapedMessage = escapeHtml(message).replace(/\n/g, "<br>");

  const content = `
<h1 class="email-title">We received your message</h1>
<p class="email-text">Hi ${firstName}, we received your message and a member of our team will reply within one business day.</p>
${renderCallout(escapedMessage, "info")}
`;
  return {
    subject,
    html: getEmailTemplate({
      title: subject,
      preheader: "We got your message and will reply within 1 business day.",
      content,
    }),
  };
}

export interface ContactReplyEmailParams {
  name: string;
  replyBody: string;
  originalMessage: string;
  originalTopic: string;
}

export function getContactReplyEmail(params: ContactReplyEmailParams): { subject: string; html: string } {
  const { name, replyBody, originalMessage, originalTopic } = params;
  const subject = `Re: your ${originalTopic} message to StreamlineOS`;
  const firstName = escapeHtml(name.split(" ")[0] ?? name);
  const escapedReply = escapeHtml(replyBody).replace(/\n/g, "<br>");
  const escapedOriginal = escapeHtml(originalMessage).replace(/\n/g, "<br>");

  const content = `
<h1 class="email-title">Re: your message</h1>
<p class="email-text">Hi ${firstName},</p>
<p class="email-text">${escapedReply}</p>
<hr class="divider" style="height:1px;background-color:#E8E8E8;margin:28px 0;border:none;">
<p class="email-label">Original message</p>
<p class="email-text" style="color:#64748b;font-size:14px;">${escapedOriginal}</p>
`;
  return {
    subject,
    html: getEmailTemplate({
      title: escapeHtml(subject),
      preheader: "A reply to your message from the StreamlineOS team.",
      content,
    }),
  };
}

export interface TrialReminderEmailParams {
  orgName: string;
  daysLeft: number;
  upgradeUrl: string;
  plan?: string;
}

export function getTrialReminderEmail(params: TrialReminderEmailParams): { subject: string; html: string } {
  const { orgName, daysLeft, upgradeUrl, plan } = params;

  const subject =
    daysLeft === 0
      ? "Your trial expires today"
      : daysLeft === 1
        ? "Your trial ends tomorrow"
        : `Your trial ends in ${daysLeft} days`;

  const endDate = new Date(Date.now() + daysLeft * 24 * 60 * 60 * 1000);
  const trialEndsOn = endDate.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const rows: Array<{ label: string; value: string }> = [];
  if (plan) rows.push({ label: "Plan", value: plan });
  rows.push({ label: "Trial ends", value: trialEndsOn });

  const expiryPhrase =
    daysLeft === 0 ? "expires today" : daysLeft === 1 ? "ends tomorrow" : `ends in ${daysLeft} days`;

  const content = `
<h1 class="email-title">${escapeHtml(subject)}</h1>
<p class="email-text">Hi ${escapeHtml(orgName)} team, your StreamlineOS free trial ${expiryPhrase}. Upgrade to keep full access to all your data and features.</p>
${renderKeyValueRows(rows)}
${renderButton("Choose a plan", upgradeUrl)}
${daysLeft <= 3 ? renderCallout("Act now — once the trial expires, access to your account will be restricted.", "warning") : ""}
`;
  return {
    subject,
    html: getEmailTemplate({
      title: subject,
      preheader: "Upgrade StreamlineOS to keep full access after your trial ends.",
      content,
    }),
  };
}
