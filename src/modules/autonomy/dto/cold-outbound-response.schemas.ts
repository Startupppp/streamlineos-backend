import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

/** What the tenant publishes in DNS to prove it controls the domain. */
const verificationRecordSchema = z.object({
  name: z.string(),
  value: z.string(),
});

/** `cold-outbound-admin.service.ts` `overview` — the track's state and its domains. */
export const coldOutboundOverviewResponseSchema = z.object({
  enabled: z.boolean(),
  enabledAt: nullableWireDate(),
  pausedAt: nullableWireDate(),
  pauseReason: z.string().nullable(),
  domains: z.array(
    z.object({
      sendingDomainId: z.string(),
      domain: z.string(),
      purpose: z.string(),
      verifiedAt: nullableWireDate(),
      warmupStartedAt: nullableWireDate(),
      /** Null once the domain is verified — there is nothing left to publish. */
      verificationRecord: verificationRecordSchema.nullable(),
    }),
  ),
});

/** `registerDomain` — a claim, always unverified, plus the record that proves it. */
export const registerSendingDomainResponseSchema = z.object({
  sendingDomainId: z.string(),
  domain: z.string(),
  purpose: z.string(),
  verificationRecord: verificationRecordSchema,
});

/** `verifyDomain`; a record that cannot be read throws rather than returning false. */
export const verifySendingDomainResponseSchema = z.object({
  verified: z.literal(true),
  verifiedAt: wireDate(),
});

/** `startWarmup`, whether it began the ramp or reported the one already running. */
export const startWarmupResponseSchema = z.object({
  warmupStartedAt: wireDate(),
});

/**
 * `setTrack`, which is `enable` or `disable` depending on the body.
 *
 * The two arms genuinely differ: enabling records when, and disabling carries no
 * instant because it leaves any pause — and its own timestamp — in place.
 */
export const setColdTrackResponseSchema = z.union([
  z.object({ enabled: z.literal(true), enabledAt: wireDate() }),
  z.object({ enabled: z.literal(false) }),
]);

/** `resume` — a tenant with no cold track throws instead. */
export const resumeColdTrackResponseSchema = z.object({ resumed: z.literal(true) });
