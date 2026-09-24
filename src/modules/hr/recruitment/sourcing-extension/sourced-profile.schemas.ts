import { z } from "zod";
import { normaliseProfileUrl } from "./sourced-profile";

/**
 * What a browser extension may send, and what it may not.
 *
 * The extension runs on a page the recruiter is reading, which means anything
 * it scrapes is attacker-influenced text from a third-party site. Every field
 * is therefore length-capped and nothing is trusted to be a URL because it was
 * called one — `profileUrl` is re-parsed here and rejected if it does not
 * normalise.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null)
    .nullable()
    .optional()
    .transform((value) => value ?? null);

export const saveSourcedProfileSchema = z
  .object({
    profileUrl: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine((raw) => normaliseProfileUrl(raw) !== null, {
        message: "profileUrl must be an http or https profile address.",
      }),
    fullName: z.string().trim().min(1, "A name is required.").max(200),
    headline: optionalText(300),
    currentCompany: optionalText(200),
    currentRole: optionalText(200),
    location: optionalText(200),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(200)
      .email("Enter a valid email address.")
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    phone: optionalText(50),
    /**
     * Capped at twenty because it is free text off a third-party page, and a
     * skills array is rendered as chips — an unbounded one is a layout weapon
     * as much as a storage one.
     */
    skills: z.array(z.string().trim().min(1).max(80)).max(20).optional().default([]),
    note: optionalText(2000),
    /**
     * DPDP: the recruiter states that they are recording personal data they can
     * see, on a page they opened, for a stated purpose. `z.literal(true)` rather
     * than a boolean with a default, so a client that omits it is refused rather
     * than silently treated as consenting.
     */
    consent: z.literal(true, {
      message: "Consent is required before a profile can be saved.",
    }),
  })
  .strict();

export type SaveSourcedProfileInput = z.infer<typeof saveSourcedProfileSchema>;

export const lookupSourcedProfileSchema = z
  .object({ profileUrl: z.string().trim().min(1).max(2000) })
  .strict();
export type LookupSourcedProfileInput = z.infer<typeof lookupSourcedProfileSchema>;

export const issueExtensionTokenSchema = z
  .object({
    /**
     * Named by the recruiter so a token list shows which browser it belongs to.
     * It lands in `user_api_tokens.name`, which the account's token screen
     * already renders.
     */
    label: z.string().trim().min(1).max(80).optional().default("Sourcing extension"),
    /**
     * Hours, capped at a working fortnight. A sourcing token lives in an
     * extension's storage on a laptop that leaves the building, so it expires
     * on its own rather than waiting for somebody to remember it exists.
     */
    expiresInHours: z.coerce.number().int().min(1).max(336).optional().default(72),
  })
  .strict();
export type IssueExtensionTokenInput = z.infer<typeof issueExtensionTokenSchema>;
