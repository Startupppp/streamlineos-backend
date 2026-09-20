import { trunc } from "./lib/prompt-text";

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
 * The event and its attendees — the two things every streamed meeting answer
 * rests on, whichever representation asked for it.
 */
function baseSources(event: MeetingPromptEvent): MeetingSource[] {
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

  return sources;
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
  const sources = baseSources(event);

  const crm = crmLink(event, opts);
  if (crm) sources.push({ id: `crm-${event.id}`, title: crm.replace("CRM Link: ", ""), snippet: "Linked CRM record" });

  return sources;
}

/**
 * The buffered follow-up and its streamed sibling must brief the model on the
 * same meeting and the same organizer input. A second copy of this block would
 * drift the moment either prompt is tuned, and the two drafts would stop
 * describing the same conversation.
 */
function followUpContextBlock(
  event: MeetingPromptEvent,
  meetingNotes: string | undefined,
  actionItems: string[] | undefined,
): string {
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

  return `MEETING DETAILS:
- Title: ${event.title}
- Date: ${event.startDate.toLocaleDateString("en-IN", { dateStyle: "full" })}
- Attendees: ${attendees}
${notesSection}
${itemsSection}`;
}

export function followUpPrompt(
  event: MeetingPromptEvent,
  meetingNotes: string | undefined,
  actionItems: string[] | undefined,
): MeetingPrompt {
  return {
    system: FOLLOW_UP_SYSTEM_PROMPT,
    user: `Generate a professional post-meeting follow-up email for the following meeting.

${followUpContextBlock(event, meetingNotes, actionItems)}

Generate:
1. A clear email subject line
2. A professional follow-up email body (in markdown)
3. A structured list of action items with assignees and due dates where identifiable
4. A suggested next meeting date if a follow-up is needed`,
  };
}

/**
 * The streamed sibling asks for prose because the wire carries raw text deltas.
 * It asks for the same four things the structured schema holds, written as
 * markdown sections in a fixed order, so the panel can fold the arriving text
 * back into a draft it can still send. The action-item line is delimited rather
 * than free-form for exactly that reason: `owner:` and `due:` survive being read
 * from a half-arrived line, where a prose sentence does not.
 */
export function followUpStreamPrompt(
  event: MeetingPromptEvent,
  meetingNotes: string | undefined,
  actionItems: string[] | undefined,
): MeetingPrompt {
  return {
    system: FOLLOW_UP_SYSTEM_PROMPT,
    user: `Write a post-meeting follow-up email for the following meeting.

${followUpContextBlock(event, meetingNotes, actionItems)}

Write plain markdown with these sections, in this order, and nothing else:
## Subject
The email subject, on one line.
## Email
The follow-up email body.
## Action items
One bullet per item, each written exactly as:
- <what needs doing> | owner: <name or unassigned> | due: <date or none>
## Next meeting
A suggested date on one line, or the single word none.

Use only the meeting details above. Do not invent attendees, decisions, owners or dates that are not stated.`,
  };
}

const SNIPPET_MAX = 160;

function snippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > SNIPPET_MAX ? `${collapsed.slice(0, SNIPPET_MAX)}…` : collapsed;
}

/**
 * What a streamed follow-up actually rests on, built from the context this
 * service assembled rather than asked of the model. The organizer's own notes
 * and supplied action items are inputs the draft is derived from, so they are
 * cited as such; a truncated stream keeps them because they go out with the
 * headers.
 */
export function followUpSources(
  event: MeetingPromptEvent,
  meetingNotes: string | undefined,
  actionItems: string[] | undefined,
): MeetingSource[] {
  const sources = baseSources(event);

  if (meetingNotes && meetingNotes.trim().length > 0) {
    sources.push({
      id: `notes-${event.id}`,
      title: "Organizer meeting notes",
      snippet: snippet(meetingNotes),
    });
  }

  const supplied = actionItems?.filter((item) => item.trim().length > 0) ?? [];
  if (supplied.length > 0) {
    sources.push({
      id: `action-items-${event.id}`,
      title: `${supplied.length} supplied action item${supplied.length === 1 ? "" : "s"}`,
      snippet: snippet(supplied.join("; ")),
    });
  }

  return sources;
}
