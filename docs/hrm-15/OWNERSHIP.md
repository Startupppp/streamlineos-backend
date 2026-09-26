# HRM-15 — File ownership map

Worktrees (never the main checkouts, which hold other sessions' dirty work):
- backend: `/Users/tarunchintakunta/Personal/streamline/hrm15-backend` (branch `hrms/hrm-15-reporting-managers`)
- frontend: `/Users/tarunchintakunta/Personal/streamline/hrm15-frontend` (branch `hrms/hrm-15-reporting-managers`)

Anyone may READ any file. Only the owner EDITS, formats, moves, deletes or regenerates it.

## Agent A — backend data model + canonical services
- `migrations/1214_*` … `migrations/1219_*`, `migrations/rollback/121[4-9]_*`, **`migrations/meta/_journal.json` (sole owner)**
- `src/db/schema/hr/core-people.ts`, new `src/db/schema/hr/reporting-manager.ts`, and the schema barrel line(s) exporting it
- `src/common/hr/sync-canonical-reporting-line.ts` (+ spec)
- `src/modules/directory/reporting-line.service.ts`, `reporting-line.types.ts`, `employment-query.ts`
- new `src/modules/directory/reporting-manager-policy.service.ts`, `reporting-manager-fallback.resolver.ts`,
  `reporting-relationship.service.ts`, `reporting-line-errors.ts` (+ specs, `.db.spec.ts`)
- `src/modules/directory/directory.module.ts`, `employment-facts.module.ts` (provider wiring only)
- `src/modules/rbac/permissions/hr-foundation.permissions.ts`, `src/modules/rbac/role-templates-hr.constants.ts`
- approval-routing primary-only test under `src/modules/directory/__tests__/`

## Agent B — backend commands, controllers, DTOs, import/onboarding integration
- `src/modules/hr/directory/reporting-lines.controller.ts`, `dto/reporting-lines-*.ts`
- new `src/modules/hr/directory/reporting-manager-policy.controller.ts`, `reporting-manager-requests*.{controller,service}.ts`,
  `my-reporting-line.controller.ts`, `reporting-line-bulk-jobs*.{controller,service}.ts`, `reporting-manager-columns.ts`
  (THE single manager-column normaliser shared by bulk onboarding + staged import)
- `src/modules/hr/directory/hr-directory.module.ts`
- `src/modules/hr/directory/employee-onboarding.service.ts`, `employees.controller.ts`, `employee-bulk-onboarding.service.ts`,
  `employee-mutations.service.ts`, `bulk-onboarding/**`, `dto/hr-directory.schemas.ts`, `dto/directory-response.schemas.ts`
- `src/modules/hr/import/**`
- `src/modules/hr/core/hr-effective-change-applier.service.ts`
- `src/modules/users/users.service.ts`, `user-ops.service.ts`, `user-profile.service.ts` (only if a call signature changes)
- their specs and e2e specs

## Agent C — frontend only (`hrm15-frontend/frontend/**`)
- everything under `hooks/api/hr/**`, `lib/query-keys/human-resources.ts`, `lib/hr-workforce-cache.ts`, `lib/validation/hr.ts`,
  `types/hr/**`, `components/hr/**`, `features/hr/**`, `features/settings/**` (reporting-line section only),
  `app/(authenticated)/hr/**`, `app/(authenticated)/settings/**`, sidebar nav files, `lib/rbac/permissions/**`,
  `PAGES.md`, and their tests
- NOT `contracts/openapi.json`, NOT `contracts/permission-catalog.json` (main agent regenerates in Block 3)

## Main agent (integration owner)
- `docs/hrm-15/**`, `openapi.json`, route/contract registries, `src/scripts/baselines/**` ratchets,
  frontend `contracts/**`, cross-repo wiring, final conflict resolution, rollout note.

## Shared-tree rules (backend A + B share one working tree and ONE git index)
- Commit early and often with the pathspec ON the commit: `git add -- <new files>` then
  `git commit -m "..." -- <your paths>`; verify with `git show --stat HEAD`.
- Never: `git add -A`, `git stash`, `git checkout/restore/reset`, `git show X > file`, rebase, push.
- Heavy commands (backend `tsc`, e2e, seeded runs, `next build`) take the lock first:
  `until mkdir /tmp/hrm15-heavy.lock 2>/dev/null; do sleep 20; done; <cmd>; rmdir /tmp/hrm15-heavy.lock`.
  Jest only with `--testPathPattern` and `--maxWorkers=2`, under `nice -n 15`.
- Backend tsc: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit; echo EXIT=$?` — read EXIT, a crash greps as 0 errors.
- `node_modules` is a symlink to a shared tree: NEVER `pnpm install`.
