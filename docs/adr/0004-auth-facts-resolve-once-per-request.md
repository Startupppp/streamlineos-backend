# ADR 0004: every auth fact resolves once per request

**Status:** accepted, and already in force — this ADR is written from the code, not ahead of it.
**Date:** 2026-09-19. Cited by `src/common/auth/auth-context.ts:18` and `backend/CLAUDE.md` §5.
**Decision:** module availability, membership state and MFA state are resolved **at most once per request**, behind `AuthContext`, and nothing calls the underlying lookup directly.

---

## The problem

Three facts are needed to answer "may this actor do this":

| Fact | Lookup | Read by |
|---|---|---|
| Is the module available to this org? | `moduleAvailability(user, moduleKey)` | `ModuleGuard`, `authorize()` |
| Is the membership live? | `MembershipStateService.resolve(userId, orgId)` | `JwtAuthGuard`, the access snapshot |
| Is MFA satisfied? | `mfaPolicy.resolve(orgId, userId)` | `MfaGuard`, the access snapshot |

Each has more than one reader, and the readers run in a fixed order on every
request: `RouteClassifierGuard` → `JwtAuthGuard` → `MfaGuard` → `ModuleGuard` →
the handler. Left to themselves, each reader queries for itself. The membership
read is the worst case — `MembershipStateService.resolve` joins `users.isActive`,
`users.deletedAt`, `organizations.status` and `organizations.deletedAt`, so it is
not a single indexed lookup.

Two costs, one of which is not a cost but a correctness problem:

1. The obvious one: N queries for one fact, on the hot path of every request.
2. The load-bearing one: **two readers of the same fact can disagree.** If
   `MfaGuard` and the access snapshot resolve MFA separately, a policy change
   landing between them produces a request that is half-authorised under the old
   policy and half under the new one. Nothing errors.

## The decision

`AuthContext` (`src/common/auth/auth-context.ts`) is an object bound to **one
actor and one tenant**, holding a memo per fact:

```ts
export interface AuthContext {
  readonly actor: CurrentUserContext;
  moduleAvailable(moduleKey: string): Promise<ModuleAvailabilityResult>;
  membership(): Promise<MembershipState>;
  mfa(): Promise<MfaState>;
}
```

Three properties make it work, and all three are in the implementation rather
than in a convention:

**It memoises the promise, not the value.** `modules` is a
`Map<string, Promise<ModuleAvailabilityResult>>` and `membership` / `mfa` are
`Promise | null`. Two guards that both ask before either resolves share one
in-flight query instead of racing two. Memoising the settled value would not
have done that.

**The module key is normalised before it is memoised** — `moduleKey.trim().toLowerCase()`
— so `"HR"` and `"hr"` are one entry, not two. Note that `backend/CLAUDE.md` §5
warns there are two module-key vocabularies in the codebase; this normalisation
folds case, not vocabulary.

**A seeded fact is not re-read.** `createAuthContext` takes an optional
`resolvedMembership`, and `JwtAuthGuard` passes the membership it has already
resolved. Without that, the guard's own read and the snapshot's read would be two
queries for one row.

The no-organisation case is a value, not a throw: with no `actor.orgId` there is
no membership row to read and no tenant to read it under, so `membership()`
answers the `NO_MEMBERSHIP` constant.

## What this does not do

**It is not a cache.** Its lifetime is the request. It has no TTL, no key beyond
the actor it was constructed with, and no invalidation — because it never
outlives the thing that would need invalidating. The permission *resolution*
cache, keyed `(userId, orgId)` in Redis and busted by `bumpPermissionsVersion`,
is a separate mechanism with separate rules (root §9's writer matrix applies
there, not here).

**It is not an authority.** It memoises the answer the lookup gave. It does not
decide anything, and a cached-looking `true` from it is exactly as authoritative
as the lookup that produced it.

**It does not fix guard ordering.** Guards run before interceptors, so a guard's
own DB query still has no tenant GUC and still needs wrapping (`backend/CLAUDE.md`
§4). Sharing one read between two guards does not change which side of the
interceptor that read happens on.

## The rule that holds

> Nothing reads `MembershipStateService`, the MFA policy, or the module
> availability lookup directly on a request path. It goes through the request's
> `AuthContext`, and that context answers only for the actor and tenant it was
> built with.

The second clause is the one that matters. A context reused across actors would
return one person's membership for another's request — which is why
`createAuthContext` closes over `actor` instead of taking it per call.

See also [ADR 0006](0006-auth-facts-reach-guards-through-di-tokens.md), which
covers how the three lookups reach the factory without the guards importing
their modules.
