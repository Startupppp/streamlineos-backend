/**
 * Which service methods touch the database with no way to scope a tenant?
 *
 * A LEAD GENERATOR, NOT A GATE. It is deliberately not wired into `check:*`,
 * because it reports candidates and a meaningful share of them are correct by
 * design — `auth`, `sessions`, `mfa` and `platform` operate on global identity
 * tables that have no `org_id` at all, and token-authenticated public surfaces
 * authorize by the token rather than the org. Making it a gate would either
 * demand an allowlist nobody maintains or ship red forever, and a red gate is a
 * gate people learn to skip.
 *
 * WHY IT EXISTS. `SignEnvelopeSweepsService.runReminderSweep()` and
 * `runExpirationSweep()` took no `orgId` and filtered on none. No `sign_*` table
 * is under RLS, so those two swept every tenant in the database: an admin in one
 * organisation re-issued signing tokens for recipients in all of them and
 * expired their envelopes. Nothing caught it — not typecheck, not the unit
 * suites, not `check:tenant-isolation`, which covers 21% of tenant-owned
 * services.
 *
 * WHY THE NARROW QUESTION. The broad one is useless here. Grepping e-sign for
 * "a WHERE with no orgId in it" returns 59 hits and almost all are the safe
 * pattern — `const row = await this.get(orgId, id)` throws NotFoundException
 * for another tenant's row, so the bare-id UPDATE underneath is acting on an id
 * already proven to belong to the caller. This asks the checkable question
 * instead: a method with no tenant argument cannot scope anything, however
 * carefully its body is written.
 *
 * VERIFIED AGAINST THE KNOWN BUG. Run against `21ac1783b`, the commit before
 * the fix, it reports both sweeps. Run against the fix, e-sign disappears from
 * the output entirely. An earlier draft suppressed any body mentioning `orgId:`
 * anywhere and found only 1 of the 2 — `runExpirationSweep` writes
 * `orgId: envelope.orgId` into an audit record while its own query has no org
 * predicate at all — so the exclusion is now scoped to an insert's `values()`.
 * A detector that finds half the bugs it was built for is the failure this
 * codebase keeps meeting; check any change to it the same way.
 *
 *     node src/scripts/census-orgless-service-methods.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
function walk(d, o = []) { for (const e of readdirSync(d)) { const p = join(d, e); const s = statSync(p); if (s.isDirectory()) { if (e !== "node_modules") walk(p, o); } else o.push(p); } return o; }
const METHOD = /^\s{2}(?:async\s+)?(?!constructor|if|for|while|switch|return|catch)([a-zA-Z][\w]*)\s*\(([^)]*)\)/;
const byModule = new Map();
let total = 0;
for (const f of walk("src/modules")) {
  if (!f.endsWith(".service.ts") || f.includes("spec")) continue;
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("*") || t.startsWith("//")) return;
    const m = METHOD.exec(line);
    if (!m) return;
    const [, name, argsHead] = m;
    let args = argsHead;
    if (!line.includes(")")) args = lines.slice(i, i + 10).join(" ");
    if (/orgId|organizationId|actor|CurrentUserContext|RequestActorContext|tenant|token|hash|slug/i.test(args)) return;
    const body = lines.slice(i, i + 40).join("\n");
    if (!/this\.db|tx\./.test(body)) return;
    /*
     * An insert whose VALUES carry an org is scoped, just not positionally.
     * Scoped to the values() call on purpose: matching `orgId:` anywhere in the
     * body suppressed a real finding — `runExpirationSweep` mentions
     * `orgId: envelope.orgId` inside an audit record while its own query has no
     * org predicate at all. That heuristic found 1 of the 2 known bugs, which is
     * the failure mode this whole effort keeps meeting.
     */
    const values = /\.values\(\{[\s\S]{0,400}?\}/.exec(body);
    if (values && /orgId\s*:/.test(values[0])) return;
    if (/forEachOrg|withTenant|runInNewTenantTransaction/.test(body)) return;
    total++;
    const mod = f.split("/")[2];
    byModule.set(mod, (byModule.get(mod) ?? 0) + 1);
  });
}
console.log(`repo-wide: service methods touching the db with no tenant argument and no org in the payload: ${total}`);
for (const [m, c] of [...byModule].sort((a,b) => b[1]-a[1]).slice(0, 18)) console.log(`  ${String(c).padStart(4)}  ${m}`);
