import { z } from "zod";

/**
 * Response contract for `AuthController` handlers.
 *
 * Schemas derived from service projections, not client-side interfaces.
 * `ResponseContractInterceptor` validates every response under `NODE_ENV=test`.
 *
 * `logout` returns `Promise<void>` and cannot be described with either
 * `@ResponseSchema` or `@NoContentResponse` (`@HttpCode` is 200, not 204);
 * it is the one handler in this controller left without a contract.
 *
 * NOT `.strict()`: added response fields are backward-compatible.
 */

/** `AuthService.register` — `auth.service.ts`. */
export const authRegisterResponseSchema = z.object({
  success: z.literal(true),
});

/** `AuthPasswordlessService.verifyEmail` — issues a magic-link auto-login token. */
export const authAutoLoginTokenResponseSchema = z.object({
  autoLoginToken: z.string(),
});

/** Inline in controller: `resendVerification`, `requestMagicLink`, `requestEmailOtp`. */
export const authMessageResponseSchema = z.object({
  message: z.string(),
});

/** `AuthAnalyticsService.getAuditAnalytics` — counts for the settings audit panel. */
export const authAuditAnalyticsResponseSchema = z.object({
  loginsToday: z.number().int(),
  failedLoginsLast7Days: z.number().int(),
  activeSessions: z.number().int(),
});

/**
 * `AuthService.getSessionData` — full user + org projection used by NextAuth
 * to hydrate the session. All timestamps stored as ISO strings because this
 * is cached and only re-read by the web tier, never by a Drizzle query.
 */
export const authSessionDataResponseSchema = z.object({
  userId: z.string(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  role: z.string().nullable(),
  isActive: z.boolean(),
  orgId: z.string().nullable(),
  cellId: z.string().nullable(),
  isOrgOwner: z.boolean(),
  enabledModules: z.array(z.string()),
  orgOnboardingCompletedAt: z.string().nullable(),
  userOnboardingCompletedAt: z.string().nullable(),
  plan: z.string().nullable(),
  organizationAccess: z.enum(["active", "suspended", "none"]),
  suspendedOrganizationName: z.string().nullable(),
});

/**
 * `AuthPasswordlessService.verifyMagicLink` — session identity after a
 * successful link click. NOT the full session data: the web tier performs a
 * second `session-data` fetch with these three values.
 */
export const authVerifyMagicLinkResponseSchema = z.object({
  userId: z.string(),
  orgId: z.string(),
  sessionId: z.string(),
});

/**
 * `AuthService.googleOAuth` — identity issued after Google OAuth.
 * Same shape as verifyMagicLink for the two legacy fields; `isNewUser` tells
 * the web tier whether to run onboarding.
 */
export const authGoogleOAuthResponseSchema = z.object({
  userId: z.string(),
  isNewUser: z.boolean(),
  sessionId: z.string(),
});

/**
 * `AuthController.sessionExchange` — typed inline in the handler as `{ token: string }`.
 * Carries a backend JWT; the content is sensitive and must not be widened.
 */
export const authSessionExchangeResponseSchema = z.object({
  token: z.string(),
});

/**
 * `JwtKeyringService.getJwks` — JWKS document served at
 * `GET /auth/.well-known/jwks.json`. Each entry is a public JWK object
 * whose exact members depend on the algorithm; `z.record` passes any string
 * map rather than listing algorithm-specific fields.
 */
export const authJwksResponseSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())),
});
