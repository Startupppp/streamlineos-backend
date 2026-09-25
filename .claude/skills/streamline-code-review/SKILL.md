---
name: streamline-code-review
description: |
  Review StreamlineOS changes against this codebase's own rules and gates, and
  ATTRIBUTE failures correctly before calling anything a regression. Use when
  reviewing a diff, branch or PR in streamlineos-backend or
  streamlineos-frontend; when a gate, lint or suite goes red and you need to
  know whether your change caused it; when a gate exits 2; when deciding
  whether a ratchet file may be widened; or when someone reports work as
  "done". The default failure mode here is not a missed bug — it is a green
  report over code nothing executed, and a red gate blamed on the wrong change.
  Reach for this before writing a review verdict, not after.
---

# Reviewing StreamlineOS

Two repos, two rule sets: `streamlineos-backend/CLAUDE.md` (BE-01…BE-142) and
`streamlineos-frontend/frontend/CLAUDE.md` (FE-*). Cite rules by ID. Read the
rule before citing it — several summaries in circulation are stale.

## Attribute before you blame

**Gates here are wrong more often than the code is** — four for four on one
audit. Before reporting any failure as caused by the change under review,
measure the same thing on a clean `origin/main`:

```bash
git worktree add --detach /tmp/main-check origin/main
ln -s "$(pwd)/node_modules" /tmp/main-check/node_modules   # never run an install
cd /tmp/main-check && <the failing command>
rm -f /tmp/main-check/node_modules && git worktree remove --force /tmp/main-check
```

The symlink matters: worktrees here share node_modules, and an install in one
breaks suites in another. Remove the symlink before removing the worktree or
you delete the real directory.

Measured examples worth knowing: `typecheck:test` reports 13 errors in six spec
files and `origin/main` reports the same 13; the frontend
`denial-is-not-emptiness` ratchet fails with 5 unlisted surfaces and 7 stale
wiki entries on main too; `check:module-di` names `ExpenseApprovalAdapter`;
`origin/main`'s migration journal has a non-increasing `when` at position 342.
None of those are anyone's regression.

**Exit 2 is not a verdict.** Nine gates exit 2 when a prerequisite env var or
fixture is missing. That means "did not run", not "passed" and not "failed".

**`--passWithNoTests` is a failure**, and a gate that resolved no files reports
zero vacuously — run the `:self-test` sibling first where one exists.

## Does the code actually run?

Most of what gets shipped broken here compiles and passes.

- **Reach.** A module can be complete and unreachable. Grep for a caller
  *outside* the module before accepting "done". A self-marked ticket status
  means code was written, nothing more.
- **Registration.** An unregistered controller or provider compiles green and
  does not exist (BE-01). `check:module-di` and `check:module-registration`
  catch it; a merge dropping a provider is a known failure mode here, so re-run
  both after any merge.
- **Vacuous gates.** `check:openapi-coverage` and `check:contract-registry`
  pass trivially for an unregistered controller. Register first, then re-run,
  or the green means nothing.
- **Arity.** `typecheck` does not see constructor arity in specs.
  `typecheck:test` is the only gate that does (BE-138) — run it after any
  signature change. Give tsc 10-12 GB; at 8 GB it dies exit 134 printing no
  errors, and a crashed tsc greps as "0 errors".

## Tests that agree with the bug

- A fixture shaped like the defect is how the defect survives. When a test
  documents current behaviour, ask whether that behaviour is correct — one spec
  here asserted that the candidate status page leaked the candidate's email.
- **Doubles invent the callee.** A `jest.fn()` for a method the real service
  does not have makes a dead branch look live. It broke six MCP tools once.
- A `db.transaction` mock must invoke its callback, or every assertion inside
  it is void (BE-136).
- Pair every negative assertion with a positive one — a status-only negative
  passes on a 500 (BE-141).
- **Mutation-test anything you claim is fixed.** Undo the fix; if the suite
  stays green, the test proves nothing.
- Blank jest failures with an empty assertion message mean a stale cache:
  `--clearCache`.

## Ratchets may only shrink

`denial-is-not-emptiness.known.json` and the other ratchet ledgers are
shrink-only (FE-48). Widening one to go green converts a defect into a
permanent exemption. If your change legitimately makes an entry obsolete,
remove it — that is the allowed direction.

## Review checklist

Correctness and reach first, then:

- Exposure declared exactly once per route (BE-30) — see
  `streamline-security-review` for the whole surface
- Explicit projections, no raw ORM rows (BE-07); list reads bounded (BE-132)
- `.strict()` on every boundary schema (BE-13); every route param declared (BE-14)
- No `any`, no `as X`, no `@ts-ignore` (hard zero)
- Money: GL is integer `*_minor`, HR/timesheets is decimal major. Mixing them
  is a 100x error, and both conventions are live.
- Frontend: `usePageState` + `<PageState>` with `error` passed (FE-40/41),
  `useCanState(key) !== "denied"` for surfaces (FE-43), design tokens only —
  `no-raw-visual-values` is an error, not a warning (FE-92)
- Migrations: use `streamline-migrations`, which covers the four silent failures

## Reporting

Separate regressions from pre-existing failures on a clean tree, and say which
is which with the measurement that decided it. State what you did **not** run —
"no browser" and "no booted app" are real limits, and API proof does not
substitute for a click you did not perform. Never claim zero bugs from static
checks.
