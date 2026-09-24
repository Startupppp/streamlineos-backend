/**
 * The one vocabulary every recruitment integration uses to say "not now, and
 * here is why".
 *
 * Ten of the eighteen world-class tickets are provider-shaped — job boards,
 * LinkedIn RSC, calendar free/busy, transcription, voice screening,
 * assessments, background verification, identity checks, WhatsApp, Slack and
 * Teams. None of them has live credentials on this deployment, and the failure
 * mode the brief names is not that they are missing: it is that a product
 * without them reports success anyway. `PUBLISHED`, `SYNC_INITIATED`,
 * `CLEARED` and `Verified` were all written by code that made no network call.
 *
 * So the blocked state is a first-class value, shared across every family,
 * rather than a per-module string. The four codes are the four different
 * problems a recruiter can have, and each has a different answer:
 *
 * - `no-integration`  nobody has connected this provider for the organisation
 * - `inactive`        it is connected and switched off
 * - `needs-keys`      it is connected and switched on with no credentials
 * - `not-implemented` credentials exist and no adapter can use them
 *
 * The last one is the honest state of most of this file's consumers today, and
 * it is deliberately distinguishable from the other three: "you have not
 * finished setting this up" and "we cannot do this at all" must never read the
 * same on screen.
 */

export const BLOCKED_CODES = [
  "no-integration",
  "inactive",
  "needs-keys",
  "not-implemented",
] as const;

export type BlockedCode = (typeof BLOCKED_CODES)[number];

export interface ProviderBlocked {
  readonly provider: string;
  readonly status: "BLOCKED";
  readonly code: BlockedCode;
  readonly message: string;
}

/**
 * What each code means to the person reading it, phrased as the next action
 * they can take. `not-implemented` names the manual fallback, because for that
 * code there is nothing to configure and telling someone to check their
 * settings would send them looking for a switch that does not exist.
 */
export function blockedMessage(code: BlockedCode, subject: string, manualFallback?: string): string {
  switch (code) {
    case "no-integration":
      return `${subject} is not connected. Add it under Integrations first.`;
    case "inactive":
      return `${subject} is connected but switched off. Enable it under Integrations.`;
    case "needs-keys":
      return `${subject} is switched on but has no credentials saved.`;
    case "not-implemented":
      return manualFallback
        ? `${subject} is not available yet. ${manualFallback}`
        : `${subject} is not available yet.`;
  }
}

export function blockedProvider(
  provider: string,
  code: BlockedCode,
  subject: string,
  manualFallback?: string,
): ProviderBlocked {
  return { provider, status: "BLOCKED", code, message: blockedMessage(code, subject, manualFallback) };
}

export function isBlocked(value: { status: string }): value is ProviderBlocked {
  return value.status === "BLOCKED";
}

export interface ProviderCredentials {
  readonly platform: string;
  readonly isActive: boolean;
  /** Decrypted. Null when the row exists with nothing on it. */
  readonly token: string | null;
  readonly meta: Record<string, unknown>;
}

/**
 * The decision "can this organisation use this provider right now", made once,
 * before anything is attempted — and made the same way for every family.
 *
 * `adapters` is passed rather than imported so each family keeps its own
 * registry and its own type, and so a family with an empty registry answers
 * `not-implemented` without any caller having to know that is why.
 */
export function resolveProvider<A>(
  provider: string,
  credentials: ProviderCredentials | null,
  adapters: ReadonlyMap<string, A>,
  subject: string,
  manualFallback?: string,
): { adapter: A; credentials: ProviderCredentials } | ProviderBlocked {
  if (!credentials) return blockedProvider(provider, "no-integration", subject, manualFallback);
  if (!credentials.isActive) return blockedProvider(provider, "inactive", subject, manualFallback);
  if (!credentials.token) return blockedProvider(provider, "needs-keys", subject, manualFallback);
  const adapter = adapters.get(provider);
  if (!adapter) return blockedProvider(provider, "not-implemented", subject, manualFallback);
  return { adapter, credentials };
}
