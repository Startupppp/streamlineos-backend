/**
 * Whether a candidate may be messaged on WhatsApp, and the templates that may
 * be sent when they may.
 *
 * Pure, because both halves are rules rather than plumbing: an opt-in that is
 * merely absent must not read as permission, and a template must not become a
 * channel for arbitrary text once a recruiter has one approved.
 */

export type SendDecision =
  | { allowed: true }
  | { allowed: false; reason: "never-opted-in" | "opted-out" | "opt-out-after-opt-in" };

export interface ConsentState {
  optInAt: Date | null;
  optOutAt: Date | null;
}

/**
 * The gate. Refuses unless there is a positive opt-in that has not been
 * withdrawn.
 *
 * `never-opted-in` and `opted-out` are separate reasons even though both
 * refuse. The first is a candidate a recruiter may still ask; the second is one
 * they may not, and a screen that showed the same message for both would invite
 * somebody to go and ask again.
 *
 * A withdrawal that post-dates the opt-in wins. Re-opting in requires a new
 * opt-in timestamp later than the withdrawal, which is what makes the order of
 * the two columns meaningful rather than decorative.
 */
export function decideSend(state: ConsentState): SendDecision {
  if (state.optInAt === null) {
    return { allowed: false, reason: state.optOutAt ? "opted-out" : "never-opted-in" };
  }
  if (state.optOutAt && state.optOutAt.getTime() >= state.optInAt.getTime()) {
    return { allowed: false, reason: "opt-out-after-opt-in" };
  }
  return { allowed: true };
}

export const SEND_REFUSAL_COPY: Record<
  Exclude<SendDecision, { allowed: true }>["reason"],
  string
> = {
  "never-opted-in": "This candidate has not agreed to WhatsApp messages. Ask them by email first.",
  "opted-out": "This candidate asked not to be messaged on WhatsApp.",
  "opt-out-after-opt-in": "This candidate withdrew their WhatsApp consent.",
};

/**
 * The four templates recruitment sends, with the variables each accepts.
 *
 * A closed catalog rather than free text. WhatsApp business messaging requires
 * pre-approved templates, and — independently of the platform's rule — a
 * recruiter able to send arbitrary text to a candidate's personal phone under a
 * consent given for "interview logistics" is a consent that covered something
 * else.
 */
export const WHATSAPP_TEMPLATES = {
  interview_invite: {
    variables: ["candidateName", "jobTitle", "when"],
    body: "Hi {{candidateName}}, we would like to interview you for {{jobTitle}}. Proposed time: {{when}}. Reply YES to confirm.",
  },
  interview_reminder: {
    variables: ["candidateName", "when"],
    body: "Hi {{candidateName}}, a reminder about your interview at {{when}}.",
  },
  offer_nudge: {
    variables: ["candidateName", "jobTitle"],
    body: "Hi {{candidateName}}, your offer for {{jobTitle}} is waiting for a response. Let us know if you have questions.",
  },
  application_closed: {
    variables: ["candidateName", "jobTitle"],
    body: "Hi {{candidateName}}, thank you for applying for {{jobTitle}}. We are not taking this application forward.",
  },
} as const;

export type WhatsappTemplateKey = keyof typeof WHATSAPP_TEMPLATES;
export const WHATSAPP_TEMPLATE_KEYS = Object.keys(WHATSAPP_TEMPLATES) as WhatsappTemplateKey[];

export type RenderResult = { ok: true; body: string } | { ok: false; missing: string[] };

/**
 * Fills a template, refusing rather than leaving a placeholder behind.
 *
 * A message reading "Hi {{candidateName}}" on somebody's phone is worse than no
 * message, and the failure is silent unless the renderer checks — so a missing
 * variable is an error with the names in it, not a best effort.
 *
 * Variables outside the template's declared list are ignored rather than
 * substituted. That is what stops a caller smuggling extra placeholders into a
 * body that was approved without them.
 */
export function renderTemplate(
  key: WhatsappTemplateKey,
  variables: Readonly<Record<string, string>>,
): RenderResult {
  const template = WHATSAPP_TEMPLATES[key];
  const missing = template.variables.filter(
    (name) => typeof variables[name] !== "string" || variables[name]?.trim() === "",
  );
  if (missing.length > 0) return { ok: false, missing };

  const body = template.body.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    (template.variables as readonly string[]).includes(name) ? (variables[name] ?? match) : match,
  );
  return { ok: true, body };
}

/**
 * Normalises a phone number for matching an inbound message to a candidate.
 *
 * Digits only, and the last ten kept. Indian numbers arrive from WhatsApp as
 * `919876543210` and are stored by recruiters as `+91 98765 43210`,
 * `09876543210` or `9876543210`; comparing the last ten digits matches all four
 * without a country-code table this product has no reason to own.
 *
 * Ten is also why this is a match rather than an identity: two different people
 * in two different countries can share a ten-digit suffix, so the caller scopes
 * the lookup to one organisation and treats more than one hit as no hit.
 */
export function phoneMatchKey(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}
