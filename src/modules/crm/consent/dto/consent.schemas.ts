import { z } from "zod";

export const CONSENT_CHANNELS = ["EMAIL", "SMS", "WHATSAPP", "PHONE", "POST"] as const;

const channelEnum = z.enum(CONSENT_CHANNELS);

export const contactParamSchema = z
  .object({ contactId: z.coerce.number().int().positive() })
  .strict();

export const recordConsentSchema = z
  .object({
    channel: channelEnum,
    status: z.enum(["OPTED_IN", "OPTED_OUT", "UNKNOWN"]),
    // USER_ENTRY is the only source an authenticated operator may claim.
    // UNSUBSCRIBE_LINK and WEB_FORM are set by the system, never the caller,
    // so accepting them here would let an operator forge the provenance of a
    // consent record — the one field a DPDP/GDPR audit actually relies on.
    source: z.enum(["USER_ENTRY", "IMPORT", "API", "ENRICHMENT"]),
    legalBasis: z
      .enum(["CONSENT", "CONTRACT", "LEGITIMATE_INTEREST", "LEGAL_OBLIGATION"])
      .optional(),
    sourceDetail: z.string().trim().max(500).optional(),
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .strict();

export const missingConsentQuerySchema = z
  .object({ channel: channelEnum })
  .strict();

export type ContactParam = z.infer<typeof contactParamSchema>;
export type RecordConsentInput = z.infer<typeof recordConsentSchema>;
export type MissingConsentQuery = z.infer<typeof missingConsentQuerySchema>;
