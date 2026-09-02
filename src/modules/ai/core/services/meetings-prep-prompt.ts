const MAX_NOTES = 2000;

export function trunc(s: string | null | undefined): string {
  if (!s) return "";
  return s.length > MAX_NOTES ? s.slice(0, MAX_NOTES) + "…" : s;
}

export interface MeetingAttendeeContext {
  userId: string;
  name: string | null;
  status: string;
}

export interface MeetingPromptEvent {
  id: number;
  title: string;
  startDate: Date;
  endDate: Date;
  description: string | null;
  location: string | null;
  meetingUrl: string | null;
  agenda: string | null;
  linkedLeadId: number | null;
  linkedDealId: number | null;
  attendees: MeetingAttendeeContext[];
}

export interface MeetingContextOptions {
  includeCrmContext?: boolean;
  includeProjectContext?: boolean;
}

export interface MeetingSource {
  id: string;
  title: string;
  snippet?: string;
}

export const AGENDA_SYSTEM_PROMPT =
  "You are an executive assistant preparing meeting agendas. Generate structured, actionable agendas that help teams run efficient meetings. Be concise and time-aware.";

export const FOLLOW_UP_SYSTEM_PROMPT =
  "You are an executive assistant generating post-meeting follow-up emails. Write clear, professional follow-ups that summarize outcomes and clearly assign action items.";

function attendeeList(event: MeetingPromptEvent): string {
  if (event.attendees.length === 0) return "No confirmed attendees found.";
  return event.attendees.map((a) => `- ${a.name ?? a.userId} (${a.status})`).join("\n");
}

function crmLink(event: MeetingPromptEvent, opts: MeetingContextOptions): string {
  if (!opts.includeCrmContext) return "";
  if (event.linkedLeadId) return `CRM Link: Lead #${event.linkedLeadId}`;
  if (event.linkedDealId) return `CRM Link: Deal #${event.linkedDealId}`;
  return "";
}

/**
 * The buffered structured route and its streaming sibling must brief the model
 * on the same meeting. A second copy of this block would drift the moment
 * either prompt is tuned and the streamed agenda would stop describing the same
 * event the buffered one describes.
 */
function meetingDetailsBlock(event: MeetingPromptEvent, opts: MeetingContextOptions): string {
  const crm = crmLink(event, opts);
  return `MEETING DETAILS:
- Title: ${event.title}
- Date/Time: ${event.startDate.toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" })}
- Duration: ${Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60000)} minutes
- Location: ${event.location ?? "Not specified"}
- Meeting URL: ${event.meetingUrl ?? "Not specified"}
- Description: ${trunc(event.description)}
- Existing Agenda Notes: ${trunc(event.agenda)}
${crm ? `\n${crm}` : ""}

ATTENDEES:
${attendeeList(event)}`;
}

export interface MeetingPrompt {
  system: string;
  user: string;
}

export function agendaStructuredPrompt(
  event: MeetingPromptEvent,
  opts: MeetingContextOptions,
): MeetingPrompt {
  return {
    system: AGENDA_SYSTEM_PROMPT,
    user: `Generate a structured meeting agenda for the following meeting.

${meetingDetailsBlock(event, opts)}

Generate:
1. A clear meeting agenda with timed sections
2. 3-5 key topics to cover
3. Suggested total duration
4. Preparation notes for the organizer
5. Citations referencing the data sources used (meeting details, attendee list, CRM context if present)`,
  };
}

/**
 * The streamed sibling asks for prose because the wire carries raw text deltas.
 * It asks for the same five things the structured schema holds, written as
 * markdown sections, so nothing the panel used to render disappears — it moves
 * from chips into the body. Citations are NOT asked for: the streamed route
 * ships the real ones it assembled itself, rather than the ones a model invents
 * for context it was handed.
 */
export function agendaStreamPrompt(
  event: MeetingPromptEvent,
  opts: MeetingContextOptions,
): MeetingPrompt {
  return {
    system: AGENDA_SYSTEM_PROMPT,
    user: `Write a meeting agenda for the following meeting.

${meetingDetailsBlock(event, opts)}

Write plain markdown with these sections, in this order, and nothing else:
## Agenda
Timed sections covering the meeting.
## Key topics
3-5 bullets.
## Suggested duration
One line.
## Preparation notes
What the organizer should prepare.

Use only the meeting details above. Do not invent attendees, decisions or history that is not stated.`,
  };
}

/**
 * The sources a streamed agenda actually rests on, built from the context this
 * service assembled rather than asked of the model. A truncated stream still
 * carries them because they go out with the headers.
 */
export function agendaSources(
  event: MeetingPromptEvent,
  opts: MeetingContextOptions,
): MeetingSource[] {
  const sources: MeetingSource[] = [
    { id: `event-${event.id}`, title: event.title, snippet: "Calendar event details" },
  ];

  if (event.attendees.length > 0) {
    sources.push({
      id: `attendees-${event.id}`,
      title: `${event.attendees.length} attendee${event.attendees.length === 1 ? "" : "s"}`,
      snippet: event.attendees.map((a) => a.name ?? a.userId).join(", "),
    });
  }

  const crm = crmLink(event, opts);
  if (crm) sources.push({ id: `crm-${event.id}`, title: crm.replace("CRM Link: ", ""), snippet: "Linked CRM record" });

  return sources;
}

export function followUpPrompt(
  event: MeetingPromptEvent,
  meetingNotes: string | undefined,
  actionItems: string[] | undefined,
): MeetingPrompt {
  const attendees =
    event.attendees.length > 0
      ? event.attendees.map((a) => a.name ?? a.userId).join(", ")
      : "Not specified";

  const notesSection = meetingNotes
    ? `\nMEETING NOTES FROM ORGANIZER:\n${trunc(meetingNotes)}`
    : "";

  const itemsSection =
    actionItems && actionItems.length > 0
      ? `\nIDENTIFIED ACTION ITEMS:\n${actionItems.map((i) => `- ${i}`).join("\n")}`
      : "";

  return {
    system: FOLLOW_UP_SYSTEM_PROMPT,
    user: `Generate a professional post-meeting follow-up email for the following meeting.

MEETING DETAILS:
- Title: ${event.title}
- Date: ${event.startDate.toLocaleDateString("en-IN", { dateStyle: "full" })}
- Attendees: ${attendees}
${notesSection}
${itemsSection}

Generate:
1. A clear email subject line
2. A professional follow-up email body (in markdown)
3. A structured list of action items with assignees and due dates where identifiable
4. A suggested next meeting date if a follow-up is needed`,
  };
}
