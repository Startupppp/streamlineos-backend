import type { BlockedCode } from "./provider-blocked";

/**
 * Every third party Recruitment OS would talk to, what it would do, and
 * whether it can.
 *
 * Ten of the eighteen world-class tickets are a provider integration, and the
 * failure they share is not that the provider is missing — it is that a
 * product without one reports success anyway. `PUBLISHED`, `SYNC_INITIATED`,
 * `CLEARED` and `Verified` were each written by code that made no network
 * call.
 *
 * So the absence is data. This catalog is the single declaration of what
 * exists, and every settings screen, every blocked message and every
 * "connect this" banner reads it rather than restating it. A capability is
 * `available` only when an adapter is registered AND the organisation has
 * live credentials; everything else is a blocked code with a reason and,
 * where there is one, the manual fallback that still works.
 *
 * `manualFallback` is the part that keeps this honest rather than merely
 * apologetic. A recruiter told "calendar sync is not connected" can still book
 * an interview by hand, and saying so is the difference between a limitation
 * and a dead end.
 */

export const INTEGRATION_FAMILIES = [
  "job-board",
  "ats-sync",
  "calendar",
  "transcription",
  "voice-screen",
  "assessment",
  "background-check",
  "identity",
  "messaging",
  "chat-notify",
] as const;

export type IntegrationFamily = (typeof INTEGRATION_FAMILIES)[number];

export interface IntegrationDefinition {
  /** The `candidate_sources.platform` value credentials are stored under. */
  readonly platform: string;
  readonly family: IntegrationFamily;
  readonly label: string;
  /** What it does for a recruiter, in their words. */
  readonly does: string;
  /** What still works without it. Null when nothing does. */
  readonly manualFallback: string | null;
  /**
   * True when code exists that could use credentials if they were supplied.
   * False is the honest state of most of this catalog and is why
   * `not-implemented` is a distinct code from `needs-keys`: one is waiting on
   * the organisation, the other is waiting on us.
   */
  readonly adapterImplemented: boolean;
  /**
   * Why there is no adapter, when there is none. Shown to whoever asks why
   * they cannot connect it, so it names the actual dependency rather than
   * "coming soon".
   */
  readonly blockedBy: string | null;
}

export const INTEGRATION_CATALOG: readonly IntegrationDefinition[] = [
  {
    platform: "NAUKRI",
    family: "job-board",
    label: "Naukri",
    does: "Advertise open jobs and receive applications made on Naukri.",
    manualFallback: "Post the job on Naukri yourself and record the link under External boards.",
    adapterImplemented: true,
    blockedBy: null,
  },
  {
    platform: "LINKEDIN",
    family: "job-board",
    label: "LinkedIn Jobs",
    does: "Advertise open jobs and receive applications made on LinkedIn.",
    manualFallback: "Post the job on LinkedIn yourself and record the link under External boards.",
    adapterImplemented: true,
    blockedBy: null,
  },
  {
    platform: "INDEED",
    family: "job-board",
    label: "Indeed",
    does: "Advertise open jobs and receive applications made on Indeed.",
    manualFallback: "Post the job on Indeed yourself and record the link under External boards.",
    adapterImplemented: true,
    blockedBy: null,
  },
  {
    platform: "LINKEDIN_RSC",
    family: "ats-sync",
    label: "LinkedIn Recruiter System Connect",
    does: "Push candidates and stage changes into LinkedIn Recruiter, and pull InMail applies back.",
    manualFallback: "Work the candidate in Recruitment OS; LinkedIn Recruiter stays a separate list.",
    adapterImplemented: false,
    blockedBy:
      "Recruiter System Connect is a LinkedIn partner programme. It needs an approved partnership and partner keys, which this deployment does not have.",
  },
  {
    platform: "GOOGLE_CALENDAR",
    family: "calendar",
    label: "Google Calendar",
    does: "Read interviewer free/busy to suggest real slots, and write the interview back as an event.",
    manualFallback: "Offer slots by hand; the candidate still books one and still gets an ICS file.",
    adapterImplemented: false,
    blockedBy: "Needs a Google Cloud OAuth client with Calendar scopes for this deployment.",
  },
  {
    platform: "MICROSOFT_GRAPH",
    family: "calendar",
    label: "Microsoft 365 Calendar",
    does: "Read interviewer free/busy to suggest real slots, and write the interview back as an event.",
    manualFallback: "Offer slots by hand; the candidate still books one and still gets an ICS file.",
    adapterImplemented: false,
    blockedBy: "Needs a Microsoft Entra app registration with Calendars.Read for this deployment.",
  },
  {
    platform: "TRANSCRIPTION",
    family: "transcription",
    label: "Interview transcription",
    does: "Turn an interview recording into a transcript attached to the interview.",
    manualFallback: "Upload a transcript yourself; it is stored and read the same way.",
    adapterImplemented: false,
    blockedBy: "Needs a speech-to-text vendor account.",
  },
  {
    platform: "VOICE_SCREEN",
    family: "voice-screen",
    label: "Voice AI screening",
    does: "Run an automated phone screen and write the outcome onto the candidate.",
    manualFallback: "Run the screen yourself and record it as a phone interview with a scorecard.",
    adapterImplemented: false,
    blockedBy: "Needs a voice screening vendor account.",
  },
  {
    platform: "ASSESSMENT",
    family: "assessment",
    label: "Assessments",
    does: "Send a test to a candidate and receive the score before a stage move.",
    manualFallback: "Send the test from the vendor's own dashboard and record the score as a scorecard.",
    adapterImplemented: false,
    blockedBy:
      "Needs an assessment marketplace account (HackerRank, Codility or TestGorilla class).",
  },
  {
    platform: "AUTHBRIDGE",
    family: "background-check",
    label: "Background verification",
    does: "Initiate a background check after an offer is accepted and receive the agency's verdict.",
    manualFallback:
      "Run the check with your agency directly and record what they returned on the candidate.",
    adapterImplemented: false,
    blockedBy: "Needs an agency account (AuthBridge class) with API credentials.",
  },
  {
    platform: "IDENTITY",
    family: "identity",
    label: "Identity verification",
    does: "Verify a candidate's identity documents through a vendor before an offer is finalised.",
    manualFallback: "Verify documents yourself and record the outcome.",
    adapterImplemented: false,
    blockedBy: "Needs an identity vendor account. Full identity numbers are never stored here.",
  },
  {
    platform: "WHATSAPP",
    family: "messaging",
    label: "WhatsApp",
    does: "Send template messages to candidates who opted in, and file their replies.",
    manualFallback: "Email is the default channel and needs no connection.",
    adapterImplemented: false,
    blockedBy: "Needs a WhatsApp Business account with approved message templates.",
  },
  {
    platform: "SLACK",
    family: "chat-notify",
    label: "Slack",
    does: "Tell interviewers in Slack when they are assigned an interview, with a link to the scorecard.",
    manualFallback: "Interviewers are emailed and see it on their own recruitment page.",
    adapterImplemented: false,
    blockedBy: "Needs a Slack app installed in the workspace.",
  },
  {
    platform: "MICROSOFT_TEAMS",
    family: "chat-notify",
    label: "Microsoft Teams",
    does: "Tell interviewers in Teams when they are assigned an interview, with a link to the scorecard.",
    manualFallback: "Interviewers are emailed and see it on their own recruitment page.",
    adapterImplemented: false,
    blockedBy: "Needs an incoming webhook for a Teams channel.",
  },
];

export function integrationFor(platform: string): IntegrationDefinition | null {
  return INTEGRATION_CATALOG.find((entry) => entry.platform === platform) ?? null;
}

export function integrationsInFamily(family: IntegrationFamily): IntegrationDefinition[] {
  return INTEGRATION_CATALOG.filter((entry) => entry.family === family);
}

export interface IntegrationStatus extends IntegrationDefinition {
  readonly connected: boolean;
  readonly isActive: boolean;
  readonly hasCredentials: boolean;
  readonly credentialHint: string | null;
  /** `null` when the integration is usable right now. */
  readonly blockedCode: BlockedCode | null;
}

/**
 * The state of one integration for one organisation, derived rather than
 * stored — there is no column anywhere saying "this is available", because a
 * stored flag is exactly how a product ends up claiming a capability it lost.
 */
export function statusOf(
  definition: IntegrationDefinition,
  credentials: { isActive: boolean; hasCredentials: boolean; credentialHint: string | null } | null,
): IntegrationStatus {
  const base = {
    ...definition,
    connected: credentials !== null,
    isActive: credentials?.isActive ?? false,
    hasCredentials: credentials?.hasCredentials ?? false,
    credentialHint: credentials?.credentialHint ?? null,
  };

  /**
   * Order matters. "We have not built this" is reported ahead of "you have not
   * connected it", because telling someone to go and find credentials for a
   * thing that could not use them is worse than saying nothing.
   */
  if (!definition.adapterImplemented) return { ...base, blockedCode: "not-implemented" };
  if (credentials === null) return { ...base, blockedCode: "no-integration" };
  if (!credentials.isActive) return { ...base, blockedCode: "inactive" };
  if (!credentials.hasCredentials) return { ...base, blockedCode: "needs-keys" };
  return { ...base, blockedCode: null };
}
