import { armMailEgressTripwire } from "./mail-egress-tripwire";

/**
 * No seeded run may reach a mail provider. Armed here, for every seeded file.
 *
 * `createSeededE2eApp` overrides `EmailProviderService` with an in-memory
 * capture, which is what stops the sends we know about. This is the floor under
 * that: it blocks the socket itself, so a mail path that never passes through
 * `EmailProviderService` — a service that builds its own client, a new SDK, a
 * spec that boots its own Nest app — fails loudly instead of quietly spending
 * live Resend quota.
 *
 * It lives in `setupFiles` rather than in the harness because one seeded spec
 * (`crm-attribution-fanout`) never calls `createSeededE2eApp` at all, and a
 * guarantee with a documented hole in it is not one. `setupFiles` runs per test
 * file, before the framework is installed, so every seeded file is covered from
 * its first line and nothing needs to remember to disarm.
 *
 * Blocking IS the assertion: a bypass throws and fails its suite, so the other
 * 41 specs get this protection without each having to assert it. What that
 * cannot catch is the tripwire silently not being armed — if this file is
 * dropped from `setupFiles`, every suite still passes. `seeded-e2e-app.spec.ts`
 * holds that floor by requiring the tripwire to actually fire.
 */
armMailEgressTripwire();
