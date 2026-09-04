/**
 * Gate: no caller may mint a short-lived download URL without an authorization
 * recheck, and every deliberate bypass is declared.
 *
 * The failure this exists to prevent was live at head. `StorageService.getFileUrl`
 * signed whatever key it was handed; the recheck (`assertKeyReadable`) ran on
 * exactly ONE of fourteen call sites. The other thirteen authorised the ROW and
 * then trusted the key the row carried, so a key a client had once chosen — a
 * chat attachment naming its own tenant's `documents/` folder, a vault row
 * holding a foreign prefix — became a signed URL for an object its reader was
 * never entitled to, and the quarantine verdict was unreachable from all of them.
 *
 * The fix put the refusal INSIDE the minting primitive, where no caller can omit
 * it. This gate keeps it there. Two rules:
 *
 *   1. PRIMITIVE — `StorageService.getFileUrl` must call `assertKeySignable`
 *      before it resolves a placement, and `assertKeySignable` must still refuse
 *      a malformed key, a foreign-tenant key, an undeclared sensitive-folder key
 *      and a quarantined key. Deleting any one of those four silently reopens a
 *      whole class of read, and nothing else in the repo would notice.
 *
 *   2. OPT-OUT — every `preauthorized: true` argument is a statement that the
 *      caller already ran a record-scoped authorization. Each site is declared
 *      here with the check it relies on. This is NOT a place to park a violation:
 *      a caller with no such check must not be added, it must run one. An
 *      undeclared site fails, so a new bypass is a review decision rather than a
 *      one-word diff.
 *
 * A caller that passes no options at all is fine and is not listed: the primitive
 * refuses sensitive keys by default, so the safe path is the silent one.
 *
 * Usage:  node src/scripts/check-signed-url-authorization.mjs [--self-test] [--root=<dir>]
 * Exit:   0 clean · 1 the primitive lost a check or an undeclared opt-out · 2 broken pattern
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");
const rootArg = args.find((a) => a.startsWith("--root="));
const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ROOT = rootArg ? resolve(rootArg.slice("--root=".length)) : resolve(HERE, "..");

const PRIMITIVE = "modules/storage/storage.service.ts";

/**
 * Each entry names a file that passes `preauthorized: true` and the check it has
 * already run. `sites` is the expected count in that file, so a second, unaudited
 * call cannot hide behind an audited one.
 */
const DECLARED_OPT_OUTS = [
  {
    file: "modules/storage/storage.controller.ts",
    sites: 1,
    reason: "download() runs assertKeyReadable — foreign-org, resolved owner, dedicated-access and quarantine — on this exact key first",
  },
  {
    file: "modules/storage/storage-vault.controller.ts",
    sites: 1,
    reason: "hr:documents:manage plus an org- and candidate-scoped candidateDocumentsVault lookup produced the key",
  },
  {
    file: "modules/hr/lifecycle/hr-onboarding-docs-admin.controller.ts",
    sites: 1,
    reason: "hr:onboarding:manage with a resolved DataScope; getFileReference is scope-filtered",
  },
  {
    file: "modules/hr/lifecycle/onboarding-views.controller.ts",
    sites: 1,
    reason: "self:onboarding-docs with scope 'own'; getFileReference is scope-filtered",
  },
  {
    file: "modules/hr/lifecycle/exit.controller.ts",
    sites: 1,
    reason: "hr:exit:view with the acting membership; getFileReference is scope- and subject-filtered",
  },
  {
    file: "modules/hr/performance/documents.controller.ts",
    sites: 1,
    reason: "hr:documents:view with a resolved DataScope; getFileReference is scope-filtered",
  },
  {
    file: "modules/e-sign/sign-documents.service.ts",
    sites: 1,
    reason: "mustGetVisibleEnvelope binds the document to the caller's sign:envelope:view scope",
  },
  {
    file: "modules/e-sign/sign-finalization.service.ts",
    sites: 2,
    reason: "final PDF and certificate, both behind mustGetVisibleEnvelope on the caller's scope",
  },
  {
    file: "modules/e-sign/sign-public.service.ts",
    sites: 1,
    reason: "recipient signing session plus the authenticatedAt second factor asserted immediately above the call",
  },
];

const REQUIRED_IN_ASSERT = [
  ["isValidFileKey", "a malformed key would be handed to the object store verbatim"],
  ["isForeignOrgKey", "a key naming another tenant would be read out of the caller's own bucket"],
  ["isSensitiveStorageKey", "a chat or KB row could point at documents/, payslips/ or esign/"],
  ["isKeyBlocked", "an infected or unscanned object would still be minted"],
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".spec.") && !entry.name.includes(".e2e-"))
      out.push(full);
  }
  return out;
}

function countOptOuts(source) {
  return (source.match(/preauthorized:\s*true/g) ?? []).length;
}

function checkPrimitive(source) {
  const failures = [];
  const at = source.indexOf("async getFileUrl(");
  if (at === -1) return [{ rule: "primitive", detail: "getFileUrl not found — the gate's pattern is stale" , fatal: true }];
  const body = source.slice(at, source.indexOf("\n  }", at));
  if (!body.includes("assertKeySignable"))
    failures.push({ rule: "primitive", detail: "getFileUrl no longer calls assertKeySignable — every caller is ungoverned again" });
  const guardAt = source.indexOf("private async assertKeySignable(");
  if (guardAt === -1)
    return [...failures, { rule: "primitive", detail: "assertKeySignable not found", fatal: true }];
  const guard = source.slice(guardAt, source.indexOf("\n  }", guardAt));
  for (const [needle, why] of REQUIRED_IN_ASSERT)
    if (!guard.includes(needle))
      failures.push({ rule: "primitive", detail: `assertKeySignable no longer consults ${needle} — ${why}` });
  return failures;
}

function run(root) {
  const srcRoot = root;
  if (!existsSync(join(srcRoot, PRIMITIVE)))
    return { broken: true, failures: [{ rule: "primitive", detail: `${PRIMITIVE} not found under ${srcRoot}` }], scanned: 0, optOuts: [] };

  const files = walk(srcRoot);
  const failures = [...checkPrimitive(readFileSync(join(srcRoot, PRIMITIVE), "utf8"))];
  if (failures.some((f) => f.fatal)) return { broken: true, failures, scanned: files.length, optOuts: [] };

  const declared = new Map(DECLARED_OPT_OUTS.map((d) => [d.file, d]));
  const optOuts = [];
  for (const file of files) {
    const rel = relative(srcRoot, file).split("\\").join("/");
    const found = countOptOuts(readFileSync(file, "utf8"));
    if (found === 0) continue;
    optOuts.push({ file: rel, sites: found });
    const entry = declared.get(rel);
    if (!entry) {
      failures.push({ rule: "opt-out", detail: `${rel} passes preauthorized:true at ${found} site(s) and is not declared — state the record-scoped check it runs, or remove the opt-out` });
      continue;
    }
    if (entry.sites !== found)
      failures.push({ rule: "opt-out", detail: `${rel} declares ${entry.sites} opt-out site(s) but has ${found} — a new bypass must be reviewed, not inherited` });
  }
  /**
   * A declaration for a file that still exists but no longer opts out is stale
   * and is removed, so the list cannot drift into a list of files nobody checks.
   * A declaration for a file absent from this root is not judged: the gate runs
   * against fixtures too, and a missing file is out of corpus rather than clean.
   */
  for (const [rel, entry] of declared)
    if (existsSync(join(srcRoot, rel)) && !optOuts.some((o) => o.file === rel))
      failures.push({ rule: "opt-out", detail: `${rel} declares ${entry.sites} opt-out site(s) but has none — delete the stale declaration so the list stays a real inventory` });

  return { broken: false, failures, scanned: files.length, optOuts };
}

if (SELF_TEST) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const checks = [];
  const fixtureRoot = mkdtempSync(join(tmpdir(), "signed-url-gate-"));
  const write = (rel, body) => {
    const full = join(fixtureRoot, rel);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, body);
  };
  const GOOD_PRIMITIVE = `
  async getFileUrl(o: string, k: string) {
    await this.assertKeySignable(o, k, false);
    return "x";
  }

  private async assertKeySignable(o: string, k: string, p: boolean) {
    if (!this.isValidFileKey(k)) throw new Error();
    if (isForeignOrgKey(k, o)) throw new Error();
    if (!p && isSensitiveStorageKey(k, o)) throw new Error();
    if (await this.quarantine.isKeyBlocked(o, k)) throw new Error();
  }
`;
  write(PRIMITIVE, GOOD_PRIMITIVE);
  const clean = run(fixtureRoot);
  checks.push({ name: "a primitive with all four checks and no opt-outs passes", pass: clean.failures.length === 0 });

  write("modules/storage/storage.controller.ts", "getFileUrl(a, b, c, undefined, { preauthorized: true });");
  const declaredOk = run(fixtureRoot);
  checks.push({
    name: "a declared opt-out at its declared count passes",
    pass: declaredOk.failures.length === 0 && declaredOk.optOuts.length === 1,
  });

  write("modules/chat/chat-attachments.service.ts", "getFileUrl(a, b, c, undefined, { preauthorized: true });");
  const undeclared = run(fixtureRoot);
  checks.push({
    name: "an UNDECLARED opt-out fails",
    pass: undeclared.failures.some((f) => f.rule === "opt-out" && f.detail.includes("chat-attachments")),
  });
  rmSync(join(fixtureRoot, "modules/chat/chat-attachments.service.ts"));

  write("modules/storage/storage.controller.ts", "getFileUrl(a,b,c,undefined,{ preauthorized: true }); getFileUrl(d,e,f,undefined,{ preauthorized: true });");
  const extra = run(fixtureRoot);
  checks.push({
    name: "a SECOND opt-out in an already-declared file fails",
    pass: extra.failures.some((f) => f.detail.includes("declares 1 opt-out site(s) but has 2")),
  });
  write("modules/storage/storage.controller.ts", "getFileUrl(a, b, c, undefined, { preauthorized: true });");

  for (const [needle] of REQUIRED_IN_ASSERT) {
    write(PRIMITIVE, GOOD_PRIMITIVE.replace(needle, "somethingElse"));
    const weakened = run(fixtureRoot);
    checks.push({
      name: `dropping ${needle} from assertKeySignable fails`,
      pass: weakened.failures.some((f) => f.rule === "primitive" && f.detail.includes(needle)),
    });
  }

  write(PRIMITIVE, GOOD_PRIMITIVE.replace("await this.assertKeySignable(o, k, false);", ""));
  const ungated = run(fixtureRoot);
  checks.push({
    name: "removing the assertKeySignable call from getFileUrl fails",
    pass: ungated.failures.some((f) => f.detail.includes("no longer calls assertKeySignable")),
  });

  rmSync(fixtureRoot, { recursive: true, force: true });
  const pass = checks.every((c) => c.pass);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

const result = run(ROOT);
if (result.broken) {
  for (const f of result.failures) process.stdout.write(`  BROKEN  ${f.detail}\n`);
  process.stdout.write("INCONCLUSIVE — the gate could not read the primitive.\n");
  process.exit(2);
}
process.stdout.write(`check-signed-url-authorization: scanned ${result.scanned} source file(s)\n`);
for (const o of result.optOuts) process.stdout.write(`  OPT-OUT  ${o.file}  (${o.sites} site(s))\n`);
for (const f of result.failures) process.stdout.write(`  FAIL  [${f.rule}]  ${f.detail}\n`);
if (result.failures.length > 0) {
  process.stdout.write(`FAIL — ${result.failures.length} signed-URL authorization finding(s).\n`);
  process.exit(1);
}
process.stdout.write("  OK — the minting primitive still refuses, and every opt-out is declared.\n");
process.exit(0);
