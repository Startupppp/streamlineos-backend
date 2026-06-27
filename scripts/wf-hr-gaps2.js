export const meta = {
  name: 'hr-gaps-2',
  description: 'Build employees (detail/update/onboard) and leaves (approve/reject + side-effects) backend endpoints under scoped guardrails, injecting existing shared services for side-effects; add tests',
  phases: [{ title: 'Build HR gaps 2' }],
}

const FE = 'D:/projects/personal/Streamlineos/frontend'
const BE = 'D:/projects/personal/Streamlineos/backend'

const RULES = `
You add MISSING backend endpoints to ONE HR module so its frontend routes can be cut over. ADDITIVE backend work only — do not touch ${FE}, do not commit.

>>> HARD SCOPE GUARDRAILS (a prior run had an agent generate an entire unwanted KB DB subsystem — that must NOT recur) <<<
- Create/modify files ONLY under your assigned module dir ${BE}/src/modules/<YOUR_MODULE>/ (its controllers, services, dto), PLUS your one test file ${BE}/scripts/functional/gap-hr2-<YOUR_LABEL>.test.mjs.
- DO NOT create or modify: any file under src/db/** (no schema/enums/tables/columns/migrations), src/app.module.ts, src/common/**, ANY other module's files, or any new module.
- You MAY IMPORT and INJECT existing shared/@Global services to fire side-effects (e.g. EmailService, WebhooksDispatchService, the automation engine service, CacheService) and call their EXISTING methods. You may NOT add a new method to those shared services or otherwise edit their files. If a side-effect needs a method that does not already exist on a reachable service, port the DB/state part faithfully and report the missing side-effect in blockers (do NOT create it cross-module).
- Use ONLY tables/columns that already exist. If an endpoint needs schema that doesn't exist, STOP that endpoint and report a blocker — never create schema.
- Before finishing: \`cd ${BE} && git status --porcelain\` — confirm every changed path is under your module dir or your gap test file; if any other path changed (e.g. src/db, src/modules/kb, app.module), it is NOT yours — do not revert it (a concurrent agent/user owns it), but confirm YOUR edits are confined to your module.

CONTRACT FIDELITY: existing frontend hooks (${FE}/lib/api/hooks/hr/**) call your endpoint unchanged after cutover. For each endpoint read the frontend route handler at ${FE}/app/api/hr/<sub>/**/route.ts (source of truth: logic, permission gate, request + response shape, side-effects) and the calling hook. Match method + path + request + response EXACTLY.

CONVENTIONS (read a sibling method first): add to the EXISTING controller + service; @UseGuards(JwtAuthGuard)+@UseGuards(AbilityGuard)+@CheckAbility mapped from the frontend requirePermission; Zod DTO + ZodValidationPipe; Drizzle via injected Db; @CurrentUser(); transactions for multi-step writes; Nest exceptions; strict TS, no any/casts/@ts-ignore, NO comments, < 500 lines.

TEST: ${BE}/scripts/functional/gap-hr2-<YOUR_LABEL>.test.mjs ({ req, mint, check, report } from "./harness.mjs"): 401/403/400 where applicable + safe-read happy-paths only (never persist an irreversible write/email/webhook in a test). Do not run it.

SELF-VERIFY: \`cd ${BE} && npx tsc --noEmit\` exits 0 and your footprint is scoped.
`

const TASKS = [
  {
    label: 'employees', module: 'hr-directory',
    gaps: 'On the employees controller (@Controller "hr/employees" in hr-directory), add the missing handlers vs app/api/hr/employees/**: GET /hr/employees/:employeeId (employee detail), PATCH /hr/employees/:employeeId (update employee), POST /hr/employees/onboard (create/onboard an employee — mirror the frontend handler\'s validation + side-effects; if it sends a welcome email, inject EmailService and call an EXISTING welcome-email method, else port the DB part and report the email gap). The list GET /hr/employees and the :id/{manager-scorecard,profile-pdf,reports-to-me} GETs already exist. Use existing users/employee tables only.',
  },
  {
    label: 'leaves', module: 'hr-time',
    gaps: 'On the leaves controller (@Controller "hr/leaves" in hr-time), add PUT /hr/leaves/:leaveId/approve and PUT /hr/leaves/:leaveId/reject mirroring app/api/hr/leaves/[leaveId]/approve/route.ts and reject/route.ts. Port the full behavior: status transition (APPROVED/REJECTED), and the side-effects the frontend route fires — leave-balance / LOP recompute (port this DB logic, it likely belongs in hr-time), employee notification, sendLeaveStatusUpdateEmail (inject EmailService, call its existing leave-status method if present), dispatchWebhook leave.approved/leave.rejected (inject WebhooksDispatchService.dispatch), and the automation engine trigger (inject the existing automation service). For any side-effect whose service/method is not reachable from hr-time, port the core state change and report it in blockers. GET/POST /hr/leaves, PATCH /:leaveId, PATCH /:leaveId/cancel already exist.',
  },
]

phase('Build HR gaps 2')
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['label', 'module', 'endpointsAdded', 'filesChanged', 'footprintScoped', 'tscClean', 'sideEffectsWired', 'blockers'],
  properties: {
    label: { type: 'string' },
    module: { type: 'string' },
    endpointsAdded: { type: 'array', items: { type: 'string' } },
    filesChanged: { type: 'array', items: { type: 'string' } },
    footprintScoped: { type: 'boolean' },
    tscClean: { type: 'boolean' },
    sideEffectsWired: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'string' },
  },
}

const results = await parallel(TASKS.map((t) => () =>
  agent(
    `${RULES}\n\n=== YOUR MODULE: ${t.module} (touch ONLY src/modules/${t.module}/ + scripts/functional/gap-hr2-${t.label}.test.mjs) ===\nMissing endpoints:\n${t.gaps}\n\nImplement under the hard guardrails, inject existing services for side-effects (report any unreachable ones), write the test, self-verify tsc + scoped footprint.`,
    { label: `hr2:${t.label}`, phase: 'Build HR gaps 2', schema: SCHEMA },
  )))

const ok = results.filter(Boolean)
log(`built: ${ok.map((r) => `${r.label}(${r.endpointsAdded.length}ep,${r.tscClean ? 'tsc-ok' : 'TSC-FAIL'},${r.footprintScoped ? 'scoped' : 'LEAKED'}${r.blockers ? ',gaps' : ''})`).join(' ')}`)

return {
  tasks: ok.map((r) => ({ label: r.label, module: r.module, endpoints: r.endpointsAdded, files: r.filesChanged, scoped: r.footprintScoped, tscClean: r.tscClean, sideEffects: r.sideEffectsWired, blockers: r.blockers })),
}
