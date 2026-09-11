import { z } from "zod";
import { SENDING_DOMAIN_PURPOSES } from "../../../db/schema/crm/outbound";

/**
 * A hostname, and nothing that merely contains one.
 *
 * The value is interpolated into a DNS query and echoed back to the tenant in an
 * error, so "looks roughly like a domain" is not enough: at least two labels,
 * each alphanumeric with internal hyphens, no scheme, no path, no port, no
 * trailing dot. Anything the resolver would treat as a search-list suffix or a
 * relative name is refused here rather than asked about.
 */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Registering a domain says nothing about owning it.
 *
 * There is deliberately no `verifiedAt` here, and no field a caller can set to
 * assert control. The only thing that writes that column is a TXT lookup that
 * found this row's own id — otherwise one tenant could register a competitor's
 * domain and send cold mail from their reputation.
 */
export const registerSendingDomainSchema = z
  .object({
    domain: z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .regex(HOSTNAME, "Enter a domain like acme-outreach.com — no scheme, path or port."),
    purpose: z.enum(SENDING_DOMAIN_PURPOSES),
  })
  .strict();

export type RegisterSendingDomainInput = z.infer<typeof registerSendingDomainSchema>;

/**
 * Turning the track on or off carries no options.
 *
 * Every threshold the cold track respects — the ramp, the bounce and complaint
 * ceilings, the daily cap — lives in `send-guardrails.ts` and is not tenant
 * settable, for the same reason `cold-outbound-gate.spec.ts` proves no settings
 * key reaches one: a limit a tenant can raise is not a limit.
 */
export const setColdTrackSchema = z.object({ enabled: z.boolean() }).strict();

export type SetColdTrackInput = z.infer<typeof setColdTrackSchema>;
