import { addMinutes, formatLocalDate } from "./date.util";

export interface InterviewIcsInput {
  interviewId: number;
  orgId: string;
  scheduledAt: Date;
  duration: number;
  type: string;
  meetingLink: string | null;
  notes: string | null;
  location: string | null;
  candidateName: string;
  candidateEmail: string | null;
  interviewerName: string | null;
  interviewerEmail: string | null;
  orgName: string;
  organizerEmail?: string | null;
}

function formatIcsDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function foldLine(line: string): string {
  const max = 75;
  if (line.length <= max) return line;
  const chunks: string[] = [];
  chunks.push(line.slice(0, max));
  let index = max;
  while (index < line.length) {
    chunks.push(" " + line.slice(index, index + max - 1));
    index += max - 1;
  }
  return chunks.join("\r\n");
}

const FALLBACK_ORGANIZER_EMAIL = process.env["NOREPLY_EMAIL"] ?? "noreply@mail.local";

export function buildInterviewIcs(input: InterviewIcsInput): { ics: string; fileName: string } {
  const dtStart = formatIcsDate(input.scheduledAt);
  const dtEnd = formatIcsDate(addMinutes(input.scheduledAt, input.duration));
  const dtstamp = formatIcsDate(new Date());
  const uid = `interview-${input.interviewId}-${input.orgId}@streamlineos`;

  const summary = escapeIcsText(`Interview: ${input.candidateName} — ${input.type}`);

  const descriptionParts: string[] = [
    `Candidate: ${input.candidateName}`,
    `Format: ${input.type}`,
    `Duration: ${input.duration} minutes`,
  ];
  if (input.meetingLink) descriptionParts.push(`Meeting Link: ${input.meetingLink}`);
  if (input.notes) descriptionParts.push(`Notes: ${input.notes}`);
  const description = escapeIcsText(descriptionParts.join("\n"));

  const location = escapeIcsText(input.location ?? input.meetingLink ?? `${input.orgName} Office`);

  const attendeeLines: string[] = [];
  if (input.candidateEmail) {
    attendeeLines.push(
      `ATTENDEE;CN=${escapeIcsText(input.candidateName)};ROLE=REQ-PARTICIPANT:mailto:${input.candidateEmail}`,
    );
  }
  if (input.interviewerEmail) {
    attendeeLines.push(
      `ATTENDEE;CN=${escapeIcsText(input.interviewerName ?? "Interviewer")};ROLE=REQ-PARTICIPANT:mailto:${input.interviewerEmail}`,
    );
  }

  const organizerEmail = input.organizerEmail ?? FALLBACK_ORGANIZER_EMAIL;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${input.orgName}//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${location}`,
    `ORGANIZER;CN=${escapeIcsText(input.orgName)}:mailto:${organizerEmail}`,
    ...attendeeLines,
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  const ics = lines.map(foldLine).join("\r\n") + "\r\n";
  const fileName = `interview-${input.candidateName.replace(/\s+/g, "-")}-${formatLocalDate(input.scheduledAt)}.ics`;

  return { ics, fileName };
}
