import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * What a job board sends when someone applies on its site, and how we know the
 * board sent it.
 *
 * Every field here is attacker-controlled: this endpoint is public by
 * necessity, because a board cannot hold a session. So the payload is parsed
 * strictly rather than read, the signature is checked before a single field is
 * looked at, and the three vendors' different spellings are normalised in one
 * place instead of being smeared through the service.
 */

const TRIMMED = (max: number) => z.string().trim().max(max);

/**
 * Deliberately NOT `.strict()`. A board adds fields to its webhook without
 * telling anyone, and refusing the whole application because Naukri started
 * sending `campaignId` would lose a real candidate over a field we do not
 * read. Unknown keys are dropped; the ones we do read are validated exactly.
 */
export const boardApplyPayloadSchema = z.object({
  applicationId: TRIMMED(200).min(1),
  jobReference: z.union([TRIMMED(200).min(1), z.number().int().positive()]),
  candidate: z.object({
    name: TRIMMED(200).min(1),
    // Canonicalised here so the id a board sends and the id we dedupe on agree.
    email: TRIMMED(200).email().toLowerCase(),
    phone: TRIMMED(50).optional(),
    profileUrl: TRIMMED(500).optional(),
    resumeUrl: TRIMMED(1000).optional(),
    coverLetter: TRIMMED(5000).optional(),
  }),
  /**
   * Absent means absent. A board that does not tell us the applicant consented
   * produces an application with no consent timestamp, which is what keeps the
   * sequence sender from ever mailing them.
   */
  consent: z.boolean().optional(),
  answers: z.record(TRIMMED(100), TRIMMED(2000)).optional(),
});

export type BoardApplyPayload = z.infer<typeof boardApplyPayloadSchema>;

/**
 * The vendors' own field names, mapped onto the shape above.
 *
 * Each board calls the same five things by a different name, and this is the
 * only place that is true. A new board is an entry here.
 */
const FIELD_ALIASES: Record<string, readonly string[]> = {
  applicationId: ["applicationId", "applyId", "application_id", "id"],
  jobReference: ["jobReference", "referenceId", "sourceId", "externalJobPostingId", "jobId"],
  name: ["name", "candidateName", "fullName", "applicantName"],
  email: ["email", "candidateEmail", "emailAddress"],
  phone: ["phone", "mobile", "phoneNumber", "contactNumber"],
  profileUrl: ["profileUrl", "candidateProfileUrl", "publicProfileUrl"],
  resumeUrl: ["resumeUrl", "cvUrl", "resumeLink", "attachmentUrl"],
  coverLetter: ["coverLetter", "coveringLetter", "message"],
  consent: ["consent", "consentGiven", "hasConsent", "gdprConsent"],
};

function pick(source: Record<string, unknown>, field: keyof typeof FIELD_ALIASES): unknown {
  for (const alias of FIELD_ALIASES[field]!) {
    const value = source[alias];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/**
 * Flattens whatever the board sent into the canonical payload, then validates.
 *
 * Nested candidate objects are common (`{applicant: {...}}`, `{candidate: {...}}`)
 * and so is a flat body; both are read, because a mapper that only understands
 * one shape silently drops every application from the other.
 */
export function normaliseBoardApply(raw: unknown): BoardApplyPayload {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const nested = ["candidate", "applicant", "profile"]
    .map((key) => body[key])
    .find((value): value is Record<string, unknown> => typeof value === "object" && value !== null);
  const person = { ...body, ...(nested ?? {}) };

  const answersRaw = body.answers ?? body.screeningAnswers ?? body.questions;
  const answers =
    typeof answersRaw === "object" && answersRaw !== null && !Array.isArray(answersRaw)
      ? Object.fromEntries(
          Object.entries(answersRaw as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        )
      : undefined;

  const consent = pick(body, "consent");

  return boardApplyPayloadSchema.parse({
    applicationId: pick(body, "applicationId"),
    jobReference: pick(body, "jobReference"),
    candidate: {
      name: pick(person, "name"),
      email: pick(person, "email"),
      phone: pick(person, "phone"),
      profileUrl: pick(person, "profileUrl"),
      resumeUrl: pick(person, "resumeUrl"),
      coverLetter: pick(person, "coverLetter"),
    },
    consent: typeof consent === "boolean" ? consent : consent === "true" ? true : undefined,
    answers,
  });
}

/**
 * Re-exported from `integrations/vendor-signature` under the name the board
 * ingress and its spec already use.
 *
 * The check was never board-specific — background checks, assessment scores and
 * voice-screen results verify the same way — so it moved to where every vendor
 * callback can reach it rather than being copied three more times.
 */
export { verifyVendorSignature as verifyBoardSignature } from "../integrations/vendor-signature";
