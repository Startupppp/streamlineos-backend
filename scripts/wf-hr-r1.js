export const meta = {
  name: 'hr-round1',
  description: 'Build recruitment (10 endpoints), expenses, and termination-fidelity backend endpoints under strict scope guardrails; add tests',
  phases: [{ title: 'Build round 1' }],
}

const FE = 'D:/projects/personal/Streamlineos/frontend'
const BE = 'D:/projects/personal/Streamlineos/backend'

const RULES = `
You add MISSING backend endpoints so frontend routes can be cut over. ADDITIVE backend work only — do not touch ${FE}, do not commit.

>>> HARD SCOPE GUARDRAILS (a prior agent generated an entire unwanted KB DB subsystem, and another went off-task and built an unrelated UI page — NEITHER may recur) <<<
- STAY ON TASK: implement ONLY the endpoints listed for YOUR domain. Do not build UI, unrelated features, schema, or anything not listed.
- Create/modify files ONLY under YOUR assigned module dir(s) listed below, PLUS your one test file ${BE}/scripts/functional/gap-r1-<YOUR_LABEL>.test.mjs.
- DO NOT create/modify: src/db/** (no schema/enums/tables/columns/migrations), src/app.module.ts, src/common/**, any module NOT assigned to you, or any new module.
- You MAY import + inject EXISTING shared/@Global services (EmailService, WebhooksDispatchService, automation service, CacheService) and call their EXISTING methods. You may NOT add methods to them. If a side-effect needs a non-existent method/service, port the DB/state part and report it in blockers.
- Use ONLY existing tables/columns. If an endpoint needs schema that doesn't exist, skip it and report a blocker — never create schema.
- If an endpoint depends on an integration whose key may be invalid (OpenAI for AI scoring/resume-parse), follow the existing 503 ServiceUnavailableException pattern and note the runtime dependency — still implement the code.
- Before finishing: \`cd ${BE} && git status --porcelain\` — confirm every path you changed is under your assigned module dir(s) or your test file. Other paths changed by concurrent agents are NOT yours; leave them.

CONTRACT FIDELITY: existing frontend hooks call your endpoint unchanged after cutover. Read the frontend route handler at ${FE}/app/api/<path>/route.ts (source of truth) + its hook; match method+path+request+response EXACTLY.
CONVENTIONS: add to existing controller/service; JwtAuthGuard + AbilityGuard + @CheckAbility from the frontend requirePermission; Zod DTO + ZodValidationPipe; Drizzle; @CurrentUser(); Nest exceptions; strict TS, no any/casts/@ts-ignore, NO comments, <500 lines.
TEST: gap-r1-<label>.test.mjs (harness req/mint/check/report): 401/403/400 + safe reads only. Do not run it.
SELF-VERIFY: \`cd ${BE} && npx tsc --noEmit\` exits 0, footprint scoped.
`

const TASKS = [
  {
    label: 'recruitment', modules: 'hr-recruitment AND hr-interviews',
    gaps: 'Build the 10 missing endpoints vs app/api/hr/recruitment/** (match each frontend route handler): on hr-recruitment controllers — POST candidates/:candidateId/ai-score (OpenAI -> 503 if no key), GET/POST candidates/:candidateId/composite-score, POST candidates/resume-parse (OpenAI -> 503), GET+POST candidates/:candidateId/rollout-documents, GET+POST recruitment messages (threads messages list+send under the messages controller); on hr-interviews controllers — GET interviews (list), DELETE interviews/:interviewId, GET interviews/:interviewId/scorecard. VERIFY exact method+path+missing-set by diffing the frontend recruitment routes against the existing hr-recruitment + hr-interviews controllers; implement only the genuinely-missing ones. Both hr-recruitment and hr-interviews are yours.',
  },
  {
    label: 'expenses', modules: 'expenses',
    gaps: 'Build the missing endpoints vs app/api/hr/expenses/** on the existing expenses module controllers (the backend already serves POST /hr/expenses/import). Diff the 7 frontend hr/expenses routes against the expenses module and add the genuinely-missing ones (likely the expense list/create/detail/approve/reject/pay CRUD if not present), matching the frontend contract. Use existing expense tables only.',
  },
  {
    label: 'termination', modules: 'hr-lifecycle',
    gaps: 'Close the two fidelity gaps on the existing TerminationController/service (already cut-over-eligible otherwise): (1) POST /hr/termination/:terminationId/send-email currently omits the PDF letter attachment because the generator lives in hr-interviews — if hr-interviews EXPORTS a reachable PDF-generation service/provider, inject it and attach the PDF; if it is NOT reachable without editing hr-interviews, leave as-is and report the blocker (do not edit hr-interviews). (2) PATCH /hr/termination/:terminationId/complete should invalidate the HR dashboard cache — if a reachable CacheService method exists, call it for the hr dashboard keys; else report. Do not change behavior beyond these two side-effects.',
  },
]

phase('Build round 1')
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['label', 'endpointsAdded', 'filesChanged', 'footprintScoped', 'tscClean', 'onTask', 'blockers'],
  properties: {
    label: { type: 'string' },
    endpointsAdded: { type: 'array', items: { type: 'string' } },
    filesChanged: { type: 'array', items: { type: 'string' } },
    footprintScoped: { type: 'boolean' },
    tscClean: { type: 'boolean' },
    onTask: { type: 'boolean' },
    blockers: { type: 'string' },
  },
}

const results = await parallel(TASKS.map((t) => () =>
  agent(
    `${RULES}\n\n=== YOUR DOMAIN: ${t.label} — assigned module dir(s): ${t.modules} ===\nEndpoints to build:\n${t.gaps}\n\nImplement ONLY these under the hard guardrails, write gap-r1-${t.label}.test.mjs, self-verify tsc + scoped footprint. Set onTask=true to confirm you built exactly the assigned recruitment/expenses/termination endpoints and nothing unrelated.`,
    { label: `r1:${t.label}`, phase: 'Build round 1', schema: SCHEMA },
  )))

const ok = results.filter(Boolean)
log(`built: ${ok.map((r) => `${r.label}(${r.endpointsAdded.length}ep,${r.tscClean ? 'tsc-ok' : 'TSC-FAIL'},${r.footprintScoped ? 'scoped' : 'LEAKED'},${r.onTask ? 'on-task' : 'OFF-TASK'}${r.blockers ? ',gaps' : ''})`).join(' ')}`)

return { tasks: ok.map((r) => ({ label: r.label, endpoints: r.endpointsAdded, files: r.filesChanged, scoped: r.footprintScoped, tscClean: r.tscClean, onTask: r.onTask, blockers: r.blockers })) }
