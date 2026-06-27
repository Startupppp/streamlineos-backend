export const meta = {
  name: 'hr-parity',
  description: 'Read-only parity analysis of HR sub-domains: compare each app/api/hr/<sub> route vs the NestJS hr-* backend routes and classify cutover-readiness',
  phases: [{ title: 'HR parity' }],
}

const FE = 'D:/projects/personal/Streamlineos/frontend'
const BE = 'D:/projects/personal/Streamlineos/backend'

const GROUPS = [
  { label: 'recruitment', subs: ['recruitment'] },
  { label: 'time', subs: ['leaves', 'holidays', 'work-logs', 'sessions', 'change-password'] },
  { label: 'payroll-finance', subs: ['payrolls', 'expenses', 'reimbursements'] },
  { label: 'lifecycle', subs: ['performance', 'exit', 'termination'] },
  { label: 'directory-onboarding', subs: ['employees', 'my-profile', 'onboarding', 'onboarding-docs'] },
  { label: 'config-misc', subs: ['documents', 'assets', 'helpdesk', 'integrations'] },
]

const RULES = `
READ-ONLY parity analysis for HR sub-domains in a strangler-fig migration. Frontend (Next.js): ${FE}. Backend (NestJS): ${BE}. Do NOT modify, delete, or commit anything.

For EACH sub-domain assigned to you (frontend routes live under ${FE}/app/api/hr/<sub>/**):
1. FRONTEND routes: for every ${FE}/app/api/hr/<sub>/**/route.ts, derive its API path (strip app/api, drop /route.ts, [x] -> :x) and exported HTTP methods.
2. BACKEND routes: the backend serves HR under modules ${BE}/src/modules/hr-* (hr-config, hr-directory, hr-interviews, hr-lifecycle, hr-payroll, hr-performance, hr-recruitment, hr-time). Search their controllers for @Controller prefixes + @Get/@Post/@Put/@Patch/@Delete decorators that match each frontend path (the controller prefix usually starts with "hr/<sub>"). Build the backend method+path set.
3. MATCH each frontend (method, path) to an exact backend (method, path).
4. CALLER CHECK: grep how the frontend calls each endpoint (mostly ${FE}/lib/api/hooks/hr/**). They must go through apiClient. Flag any window.open / navigator.sendBeacon / <img src> / anchor-href download / raw fetch("/api/hr/...") / email-embedded absolute link / public-token path — those are NON-apiClient and block prefix-based cutover.
5. Note which /hr/<sub>/* prefixes are ALREADY in ${FE}/lib/api-client.ts MIGRATED_PREFIXES (those sub-paths are already migrated; their route files are already gone — you are analyzing only the REMAINING route files).

CLASSIFY each sub-domain:
- cutoverReady=true ONLY IF every remaining frontend route is matched by the backend (method+path) AND all callers use apiClient AND there are no public/unauth or browser-direct paths. Give prefixToAdd (usually "/hr/<sub>"; note any existing granular "/hr/<sub>/..." entries it would replace) and routesToDelete (app/api/hr/<sub>).
- Otherwise classify: needs-backend (list the exact missing method+path endpoints) and/or special (non-apiclient-caller / public-unauth / no-backend), with the reason.

Be rigorous and conservative — an unmatched method or a browser-direct caller means NOT ready.
`

phase('HR parity')
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['group', 'subdomains'],
  properties: {
    group: { type: 'string' },
    subdomains: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['sub', 'frontendRouteCount', 'matchedCount', 'cutoverReady', 'prefixToAdd', 'routesToDelete', 'missingEndpoints', 'special', 'notes'],
        properties: {
          sub: { type: 'string' },
          frontendRouteCount: { type: 'number' },
          matchedCount: { type: 'number' },
          cutoverReady: { type: 'boolean' },
          prefixToAdd: { type: 'array', items: { type: 'string' } },
          routesToDelete: { type: 'array', items: { type: 'string' } },
          missingEndpoints: { type: 'array', items: { type: 'string' } },
          special: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  },
}

const results = await parallel(GROUPS.map((g) => () =>
  agent(
    `${RULES}\n\n=== YOUR HR SUB-DOMAINS (group "${g.label}"): ${g.subs.join(', ')} ===\nAnalyze each of these app/api/hr/<sub> sub-domains and return a verdict per sub-domain.`,
    { label: `hr:${g.label}`, phase: 'HR parity', schema: SCHEMA },
  )))

const all = results.filter(Boolean).flatMap((r) => r.subdomains)
const ready = all.filter((s) => s.cutoverReady)
const needsBackend = all.filter((s) => !s.cutoverReady && s.missingEndpoints.length > 0 && !s.special)
const special = all.filter((s) => !s.cutoverReady && s.special)
log(`READY: ${ready.map((s) => s.sub).join(', ') || '(none)'}`)
log(`NEEDS-BACKEND: ${needsBackend.map((s) => `${s.sub}(${s.missingEndpoints.length})`).join(', ') || '(none)'}`)
log(`SPECIAL: ${special.map((s) => `${s.sub}:${s.special.slice(0, 20)}`).join(', ') || '(none)'}`)

return {
  ready: ready.map((s) => ({ sub: s.sub, prefixToAdd: s.prefixToAdd, routesToDelete: s.routesToDelete, routes: s.frontendRouteCount })),
  needsBackend: needsBackend.map((s) => ({ sub: s.sub, matched: s.matchedCount, total: s.frontendRouteCount, missing: s.missingEndpoints })),
  special: special.map((s) => ({ sub: s.sub, special: s.special, notes: s.notes })),
}
