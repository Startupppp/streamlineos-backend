# ADR 0006: auth facts reach the guards through DI tokens, not module imports

**Status:** accepted, written from the code. Cited alongside ADR 0004 in
`backend/CLAUDE.md` §5 ("built by `AuthContextFactory` — ADR 0004/0006").
**Date:** 2026-09-19.
**Decision:** `AuthContextFactory` depends on **interfaces behind injection
tokens**, not on the modules that implement them, so the guards can read module
availability and MFA state without the auth layer importing the RBAC and MFA
modules.

> Numbering note: `backend/CLAUDE.md` §5 is the only place that names ADR 0006, and
> it names it together with 0004. This document records what the code encodes; if
> an earlier 0006 existed with different content, it is not in either repo.

---

## The problem

ADR 0004 says the three auth facts resolve once per request behind `AuthContext`.
That is the *shape*. This is the *wiring*, and the wiring is where it would have
gone wrong.

`AuthContext` needs three lookups:

| Lookup | Lives in |
|---|---|
| module availability | the RBAC / module-availability layer |
| membership state | `common/auth/membership-state.service.ts` |
| MFA state | the MFA policy layer |

`JwtAuthGuard` and `MfaGuard` are global `APP_GUARD`s in `common/auth`. If
`common/auth` imports the RBAC module to get module availability, and the RBAC
module needs anything from `common/auth` — which it does, since authorisation
reads the actor — the import graph closes a loop. Root §9 makes the consequence
explicit and also rules out the two usual dodges: `forwardRef` hides a cycle
rather than removing one and is banned in new code, and `import type` on an
injected Nest service **erases the DI token**, producing a boot failure or, under
`@Optional`, a silent `null`.

## The decision

Invert the dependency at the auth layer. `AuthContextFactory`
(`src/common/auth/auth-context.factory.ts`) declares what it needs as interfaces
and receives implementations through tokens:

```ts
constructor(
  @Inject(MODULE_AVAILABILITY_LOOKUP) moduleAccess: ModuleAvailabilityLookup,
  membership: MembershipStateService,
  @Inject(MFA_POLICY) mfaPolicy: IMfaPolicy,
) { ... }
```

`ModuleAvailabilityLookup` is a one-method interface declared in
`auth-context.ts` itself — the consumer owns the contract, which is what makes
the inversion real rather than cosmetic. `IMfaPolicy` sits behind `MFA_POLICY` in
`mfa-policy.token.ts`. Neither token's provider is known to `common/auth`.

`MembershipStateService` is injected as a concrete class because it already lives
in `common/auth`. There is no cycle to break, so there is no token to add — a
token there would be ceremony.

The factory then narrows three service methods into three plain functions and
hands them to `createAuthContext`:

```ts
this.lookups = {
  moduleAvailability: (user, moduleKey) => moduleAccess.moduleAvailability(user, moduleKey),
  membershipState: (userId, orgId) => membership.resolve(userId, orgId),
  mfaState: (orgId, userId) => mfaPolicy.resolve(orgId, userId),
};
```

That narrowing is the second half of the decision. `createAuthContext` takes
`AuthContextLookups` — three functions — and knows nothing about Nest, about
services, or about tokens. It is testable with three fakes and no test module,
which is why the memoisation behaviour ADR 0004 depends on is cheap to pin.

## Consequences

**The auth layer is importable from anywhere.** Nothing in `common/auth` reaches
into a business module, so a module that needs the actor does not risk a cycle by
importing it. `pnpm check:cycles` (both repos, expected zero) is the proof, and
it is run rather than assumed.

**A missing provider fails at boot, not at the first request.** `@Inject` with no
registered provider is a Nest resolution error during module init. That is the
behaviour we want and the reason not to mark either token `@Optional` — an
optional MFA policy resolving to `null` would make `MfaGuard` pass silently,
which is a security failure disguised as a wiring convenience.

**The seam is only as good as its narrowest interface.** `ModuleAvailabilityLookup`
declares exactly one method. Widening it to "give me the RBAC service" would
restore the coupling while keeping the token, and the cycle gate would not catch
it, because the import would still be type-only at the declaration site. Add a
method only when the auth layer genuinely needs that fact per request.

## The rule that holds

> `common/auth` declares the interface it needs and receives an implementation
> through a token. It never imports the module that provides it, and it never
> uses `import type` on something it injects.
