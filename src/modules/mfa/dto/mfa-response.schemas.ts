import { z } from "zod";

/**
 * Response contract for `MfaController` handlers.
 *
 * Derived from the actual service return values, not from the client-side
 * type declarations. `ResponseContractInterceptor` validates every response
 * under `NODE_ENV=test`; a wrong schema fails the suite rather than silently
 * slipping into docs that nobody compares.
 *
 * NOT `.strict()`: an added response field is a backward-compatible deploy
 * and must not fail a running client. A removed or retyped field is the drift
 * these exist to catch, and a plain object already rejects both.
 */

/** `MfaService.setup` — qrDataUrl, secret and backup codes. */
export const mfaSetupResponseSchema = z.object({
  qrDataUrl: z.string(),
  secret: z.string(),
  manualEntryKey: z.string(),
  backupCodes: z.array(z.string()),
});

/** `MfaService.verify` — confirms MFA is now enabled. */
export const mfaVerifyResponseSchema = z.object({
  enabled: z.literal(true),
});

/** `MfaService.disable` — confirms MFA is now disabled. */
export const mfaDisableResponseSchema = z.object({
  disabled: z.literal(true),
});

/** `MfaService.status` — current MFA enablement state for the caller. */
export const mfaStatusResponseSchema = z.object({
  enabled: z.boolean(),
});

/** `MfaService.reset` — admin-initiated reset confirmation. */
export const mfaResetResponseSchema = z.object({
  reset: z.literal(true),
});
