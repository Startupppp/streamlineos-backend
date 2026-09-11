/**
 * A constructor-injected collaborator, stubbed to the methods one spec drives.
 *
 * Every isolation spec in this repo builds its collaborators by hand: a service
 * under test takes six injected dependencies and the test exercises two of
 * them, so the other four are stood up as `{}`. The idiom that carried that for
 * a whole release was `{ log: jest.fn() } as any`, and `as any` is the one
 * escape root CLAUDE.md §6 bans outright — it switches off checking on BOTH
 * sides at once. A stub whose method was renamed on the real service, or whose
 * mock returns the wrong shape, went on compiling and went on passing while
 * asserting nothing about the collaborator it claimed to stand for. That is the
 * same failure that turned four cross-tenant DENY assertions into permanently
 * satisfied shape assertions.
 *
 * `Partial<T>` restores the half that matters. Every key supplied is checked
 * against the real declaration — a typo, a dropped rename or an incompatible
 * mock return is a compile error under `check:spec-typecheck` — while the keys
 * left out stay absent, which is exactly what a stub is for. Reaching one that
 * the spec did not supply still fails at runtime, loudly, in the test that
 * depended on it.
 *
 * The assertion that closes the gap between "the methods this spec drives" and
 * "the declared collaborator" is written ONCE, here, instead of 158 times
 * across 28 spec files. It is the narrowest form C031 permits: local, named,
 * and pinned by `service-stub.spec.ts`, which asserts both directions — the
 * supplied methods survive the round trip, and an unsupplied one is `undefined`
 * rather than a silent no-op.
 *
 * This file is spec-support, not application code: it is named for the
 * repository's existing `*.spec-fixtures.ts` convention and is imported only
 * from specs.
 */
export function stubService<T>(impl: Partial<T>): T {
  return impl as T;
}
