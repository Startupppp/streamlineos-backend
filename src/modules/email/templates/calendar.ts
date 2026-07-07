import { escapeHtml, getEmailTemplate } from "./base";
import { renderButton, renderCallout, renderKeyValueRows } from "./components";

interface CalendarInviteParams {
  recipientName: string;
  organizerName: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string | null;
  meetingUrl?: string | null;
  description?: string | null;
}

function formatWhen(start: Date, end: Date, allDay: boolean): string {
  const dateOpts: Intl.DateTimeFormatOptions = {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    timeZone: "Asia/Kolkata",
    timeStyle: "short",
  };
  const day = start.toLocaleString("en-IN", dateOpts);
  if (allDay) return `${day} (all day)`;
  const from = start.toLocaleString("en-IN", timeOpts);
  const to = end.toLocaleString("en-IN", timeOpts);
  return `${day}, ${from} – ${to}`;
}

export function getCalendarInviteEmail(params: CalendarInviteParams): {
  subject: string;
  html: string;
} {
  const recipient = escapeHtml(params.recipientName);
  const organizer = escapeHtml(params.organizerName);
  const title = escapeHtml(params.title);
  const when = formatWhen(params.start, params.end, params.allDay);
  const description = params.description ? escapeHtml(params.description) : null;

  const rows = [
    { label: "Event", value: params.title },
    { label: "When", value: when },
    { label: "Organizer", value: params.organizerName },
    ...(params.location ? [{ label: "Location", value: params.location }] : []),
  ];

  const cta = params.meetingUrl
    ? renderButton("Join meeting", escapeHtml(params.meetingUrl))
    : "";

  const content = `<h1 class="email-title">You're invited</h1>
<p class="email-text">Hi ${recipient},</p>
<p class="email-text">${organizer} invited you to <strong>${title}</strong>.</p>
${renderKeyValueRows(rows)}
${description ? renderCallout(description, "info") : ""}
${cta}`;

  return {
    subject: `Invitation: ${params.title} — ${when}`,
    html: getEmailTemplate({
      title: "Event invitation",
      preheader: `${params.organizerName} invited you to ${params.title} on ${when}.`,
      content,
    }),
  };
}
