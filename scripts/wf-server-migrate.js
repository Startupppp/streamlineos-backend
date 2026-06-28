export const meta = {
  name: 'server-side-migrate',
  description: 'Migrate frontend server-side data (server/queries + server/actions) from direct Drizzle to the backend via serverApiClient, per domain, matching consumer shapes; report blockers',
  phases: [{ title: 'Server-side migrate' }],
}

const FE = 'D:/projects/personal/Streamlineos/frontend'

const RULES = `
You migrate ONE domain's FRONTEND server-side data layer from direct Drizzle DB access to the NestJS backend, so frontend/server/* and frontend/lib/db usage drains. Frontend root: ${FE}. Do NOT commit (git is disabled this session).

THE TOOL: a server-side backend client already exists at ${FE}/lib/api/server-client.ts exporting \`serverApiClient\` with .get<T>(path, params?) / .post<T>(path, body?) / .patch / .put / .delete. It mints the backend JWT from the server session and calls NEXT_PUBLIC_API_URL. Use it in server components, server actions, and server query files (any "server-only" / async-server context).

WHAT TO DO for your domain:
1. Find the domain's server-side data files: ${FE}/server/queries/<domain>*.ts and ${FE}/server/actions/<domain>*.ts (and any the domain's pages import). Read each function — it currently does \`db.query...\` / Drizzle against ${FE}/lib/db.
2. Find the matching backend endpoint (the backend serves this domain richly under /<domain> or similar). For each server function, replace its Drizzle body with a \`serverApiClient.get/post(...)\` call to the backend endpoint that returns the same data.
3. SHAPE FIDELITY (critical): the functions' CONSUMERS (pages/components that import them) expect the EXACT current return shape. Read those consumers. Transform the backend response inside the function so the returned shape is IDENTICAL to before — the consumers must work unchanged. If the backend shape can't be reconciled to the consumer's expected shape, leave that function as-is and report it in blockers.
4. ONLY migrate functions actually consumed by PAGES/components. If a server function is used ONLY by app/api routes or app/api/cron (a cron/route, not a page), SKIP it (those drain via route/cron cutover, not here) and note it.
5. If the backend has NO endpoint for what a function does, leave it and report the gap (do not build backend endpoints here).

HARD GUARDRAILS:
- Touch ONLY your domain's ${FE}/server/queries/<domain>*, ${FE}/server/actions/<domain>*, and the specific pages/components that consume them.
- DO NOT touch: ${FE}/lib/api/server-client.ts (use it, don't edit), anything under ${FE}/lib/db/** or ${FE}/lib/api/hooks/kb/** or ${FE}/server/queries/public-kb* or KB pages (a teammate owns KB), the api-client, schema, or any other domain.
- No new npm deps. Strict TS: no any, no casts, no @ts-ignore, NO comments. Keep named functions.
- SELF-VERIFY: \`cd ${FE} && npx tsc --noEmit 2>&1 | grep -E "<your domain file paths>"\` shows ZERO errors in the files you changed. (Ignore unrelated/other-domain errors.)

Return what you migrated, what you skipped (cron/route-only), and blockers (missing endpoint / irreconcilable shape).
`

const DOMAINS = [
  { key: 'invoices', detail: 'server/queries/invoice.ts (getInvoices/getInvoice/getInvoicePayments/getInvoiceStats/createPayment) consumed by app/(authenticated)/billing/invoices/**. Backend: /invoices (4 controllers, 11 routes).' },
  { key: 'accounting', detail: 'server/queries/accounting.ts (listLedgerAccounts/listJournalEntries/getTrialBalanceSnapshot) consumed by app/(authenticated)/accounting/**. Backend: /accounting (5 controllers, 30 routes).' },
  { key: 'dashboard', detail: 'server/queries/dashboard*.ts consumed by app/(authenticated)/dashboard/**. Backend: /dashboard (24 routes).' },
  { key: 'projects', detail: 'server/queries/projects.ts + server/actions/project-actions.ts consumed by app/(authenticated)/projects/**. Backend: /projects (7 controllers, 125 routes).' },
  { key: 'blog', detail: 'server/queries/blog.ts (getPublishedPosts/getFeaturedPosts/getPostBySlug/getCategories/getCategoryBySlug/getRelatedPosts) consumed by the blog pages. Backend: /blog (11 routes). NOTE many blog endpoints may be @Public.' },
  { key: 'expenses', detail: 'server/actions/expense-query.ts + expense-export.ts (and the expense-query/ + expense-export/ subdirs) consumed by app/(authenticated) expense pages. Backend: /hr/expenses (list/detail/report/export/page-data/categories).' },
  { key: 'onboarding', detail: 'server/actions/onboarding-actions.ts consumed by onboarding pages. Backend: /onboarding and/or /hr/onboarding. Onboarding writes may have side-effects (email) — if the backend endpoint exists use it; else report.' },
]

phase('Server-side migrate')
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['domain', 'migratedFunctions', 'filesChanged', 'skippedCronOrRoute', 'tscCleanOwnFiles', 'blockers'],
  properties: {
    domain: { type: 'string' },
    migratedFunctions: { type: 'array', items: { type: 'string' } },
    filesChanged: { type: 'array', items: { type: 'string' } },
    skippedCronOrRoute: { type: 'array', items: { type: 'string' } },
    tscCleanOwnFiles: { type: 'boolean' },
    blockers: { type: 'string' },
  },
}

const results = await parallel(DOMAINS.map((d) => () =>
  agent(
    `${RULES}\n\n=== YOUR DOMAIN: ${d.key} ===\n${d.detail}\n\nMigrate this domain's server-side data to serverApiClient under the hard guardrails, preserving consumer shapes exactly, and self-verify tsc on your changed files.`,
    { label: `srv:${d.key}`, phase: 'Server-side migrate', schema: SCHEMA },
  )))

const ok = results.filter(Boolean)
log(`migrated: ${ok.map((r) => `${r.domain}(${r.migratedFunctions.length}fn,${r.tscCleanOwnFiles ? 'tsc-ok' : 'TSC-FAIL'}${r.blockers ? ',gaps' : ''})`).join(' ')}`)

return { domains: ok.map((r) => ({ domain: r.domain, migrated: r.migratedFunctions, files: r.filesChanged, skipped: r.skippedCronOrRoute, tscClean: r.tscCleanOwnFiles, blockers: r.blockers })) }
