# ADR 0005: a DataScope is spent through `ScopedRead`, never read as a value

**Status:** accepted and enforced. Cited by `src/common/rbac/data-scope.ts:5`,
`src/scripts/check-scope-boundary.mjs`, and roughly a dozen specs.
**Date:** 2026-09-19, written from the code and the gate that already enforce it.
**Decision:** a `DataScope` leaves the resolver layer only inside a `ScopedRead`,
and the only `WHERE` a `ScopedRead` produces already carries both the tenant
predicate and the scope predicate.

---

## The problem

```ts
export type DataScope = "all" | "team" | "own" | "none";
```

Four strings. Every list read in the product needs one, and every list read has
to do two separate things with it:

1. Turn it into a row predicate — `own` means mine, `team` means my department's,
   `all` means the org's, `none` means deny.
2. **Not forget the tenant predicate**, which is a different concern that happens
   to live at the same call site.

The previous gate, `check-scope-application.mjs`, asked *"was this string spent?"*
by classifying source text. That is the wrong question asked the wrong way. A
string-typed scope can be:

- read and ignored, and the read returns the whole organisation;
- spent into a scope predicate with the tenant predicate omitted, which is a
  cross-tenant read that passes every scope check;
- compared against a literal (`if (scope === "all")`) in a branch the author
  believed was exhaustive;
- concatenated into raw SQL, which is what `hr-copilot-tools.ts` was doing as
  recently as this week.

None of those are visible to a text scan, and all four had real instances.

## The decision

Move the question into the type. `ScopedRead` (`src/modules/access/scoped-read.ts`)
holds the scope in a **private `#scope` field** and exposes no way to read it
except a named escape hatch. The `WHERE` it hands back is a `ScopedWhereToken`:

```ts
// The class binding is not exported and the private field makes it nominal,
// so no other file can produce one.
class ScopedWhereToken {
  private readonly tenantAndScopeInstalled = true;
  constructor(readonly sql: SQL) {}
}
export type ScopedWhere = ScopedWhereToken;
```

The type is exported; the constructor is not. A structurally identical object
literal does not satisfy it, because the private field makes the type nominal.
So a function that accepts a `ScopedWhere` has a compile-time guarantee that the
predicate came out of `#where`, and `#where` is three lines:

```ts
const parts: SQL[] = [eq(spec.tenant, this.orgId), this.#predicate(spec.scope), ...domain];
return new ScopedWhereToken(and(...parts) ?? sql`false`);
```

Tenant first, always, unconditionally. The caller cannot omit it because the
caller never assembles the list. And the `?? sql\`false\`` matters: an empty
conjunction is `TRUE` in SQL, so the fallback turns "I built nothing" into "match
nothing" rather than "match everything". Fail closed at the one point where a
mistake would be silent.

Two entry points, differing only in whether the continuation is async:

- `read(spec, run, whenDenied)` — `none` short-circuits to `whenDenied()` before
  any query is built.
- `compose(spec, build, whenDenied)` — the synchronous form, for callers that
  want the clause rather than the rows.

The denied branch is a **required argument**, not an optional one. A caller
cannot forget to handle `none`, because the signature will not let them.

### The two questions that are still legitimately about the value

Not every use of a scope is a row filter, so two derived booleans are exposed
instead of the string:

- `denied` — is this `none`?
- `unrestricted` — is this `all`? This gates an optional `userId` widening filter
  without leaking the scope itself. Root §5 is specific about why that gate has
  to bite: an unchecked widening filter lets any holder of the *read* key read
  anyone.

And `discriminator` exists because `own` and `team` select different rows per
person, so a cached result keyed without the actor would serve one person's rows
to the next. It returns `"all"` / `"none"` unchanged and `"<scope>:<actorId>"`
otherwise.

`broadest(a, b)` ranks `none < own < team < all` for a surface two permission
keys can unlock.

## The escape hatch, and why it is named

Some reads genuinely are not one filtered query. `ops-copilot-tools.ts` answers
payroll with a *different shape* per scope — self rows, a team refusal, or an org
summary — and there is no single predicate that expresses that.

So `rawScope(reason: string)` exists. It returns the string. It takes a reason it
does not use (`void reason`), for one purpose: the reason is written at the call
site, in the code, next to the thing it excuses.

Four files hold one today, each enumerated with its reason in
`DECLARED_RAW_SCOPE`. Adding a fifth without declaring it fails the gate.

## Enforcement

`pnpm check:scope-boundary` (`src/scripts/check-scope-boundary.mjs`) checks the
four things a type cannot:

1. `applyScope` is internal to `src/modules/access/scoped-read.ts`.
2. `ScopedRead.of` is confined to the resolver layer.
3. Every `rawScope()` call site is declared with a reason.
4. No production file outside the resolver or grant-authoring layers declares a
   `DataScope`-typed value.

Exit `0` clean · `1` a boundary is crossed · `2` the check itself is broken. It
runs in the `gates` job of `.github/workflows/ci.yml` with no `continue-on-error`.

It also reports **STALE** entries — declared escapes that no longer exist. That
is not tidiness. A stale entry is the signature of a file that was moved *off*
`ScopedRead`: the declaration outlives the call it excused, and the gate is the
only thing that notices.

### Two limits worth knowing

**The resolver layer is matched by filename.** `isResolverLayer` is
`/(^|\/)[a-z0-9-]*scope\.ts$/` or anything under `src/modules/access/`. A file
named `*-scope.ts` is treated as a resolver whether or not it is one — a helper
that got that name by coincidence inherits the permission to call
`ScopedRead.of`. Name deliberately.

**The gate checks reachability, not correctness.** It proves a scope was spent
through the seam. It does not prove the spec you passed describes the right
table, and it cannot: `spec.tenant` is a `PgColumn` and any column typechecks.

## What this does not replace

RLS. `app.current_org_id()` fails closed with `42501` where RLS is enabled, and
that is a second, independent tenant boundary. `ScopedRead` installing
`eq(spec.tenant, orgId)` is defence in depth, not a substitute — and the reverse
is also true, since RLS covers only the tables in the approved matrix.

## The rule that holds

> A `DataScope` is spent, not read. If your file needs the string, either it is
> the resolver layer, or it belongs in `DECLARED_RAW_SCOPE` with a reason someone
> else can evaluate.
