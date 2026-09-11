/**
 * Gate: no upload path may mint a permanent public object-storage URL, and no
 * upload response may carry one back to a client.
 *
 * The failure this exists to prevent already happened once. `StorageService`
 * returned `<public base>/<key>` for any folder not on a hard-coded private
 * list, four call sites persisted that value into tenant tables, and the leak
 * was invisible in review because the minting was one interpolation inside a
 * method whose name said nothing about URLs. Deleting it is not enough: the
 * next person to need "a URL for this object" will reach for the same env var,
 * so the env var itself is what is guarded.
 *
 * Two rules:
 *
 *   1. MINT — a source file that references a public object-storage base
 *      (NEXT_PUBLIC_R2_PUBLIC_URL, R2_KB_PUBLIC_URL, or the `publicUrl` /
 *      `kbPublicUrl` region-config fields) must be on MINT_ALLOWLIST with a
 *      reason. Reading a public base to *parse* an already-stored URL, or to
 *      allowlist a host, is legitimate; building one is not — and the two are
 *      not separable by text, so every reference is declared instead.
 *
 *   2. CONTRACT — no upload-result type may declare a `url` member. A field
 *      named `url` on an upload response is how the key/URL confusion travels:
 *      it survived one round of this ticket holding the object key, and every
 *      consumer that persisted it was persisting a URL a week earlier.
 *
 * A short-lived signed URL is NOT a finding: it is minted by `getSignedUrl`
 * against a private bucket, expires, and never appears in this scan because it
 * does not touch a public base.
 *
 * Usage:  node src/scripts/check-public-object-urls.mjs [--self-test] [--root=<dir>]
 * Exit:   0 clean · 1 an undeclared mint site or a `url` on an upload result · 2 broken pattern
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");
const ROOT_ARG = args.find((a) => a.startsWith("--root="))?.slice("--root=".length);

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const SCAN_ROOT = ROOT_ARG ? resolve(ROOT_ARG) : join(BACKEND_ROOT, "src");
const EXTERNAL_ROOT = ROOT_ARG !== undefined;

const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;

/**
 * The scan is only meaningful while it still finds the references it is meant
 * to police. A rename of the env var would otherwise turn this gate green by
 * making it match nothing at all.
 */
const MIN_PUBLIC_BASE_SITES = 4;

const PUBLIC_BASE_TOKENS = [
  "NEXT_PUBLIC_R2_PUBLIC_URL",
  "R2_KB_PUBLIC_URL",
  "kbPublicUrl",
  "publicUrl",
];

export const MINT_ALLOWLIST = new Map([
  [
    "src/config/env.validation.ts",
    "declares the env vars; a Zod schema entry cannot build a URL",
  ],
  [
    "src/common/region/region.config.ts",
    "reads the per-region public bases into the region binding; no key is ever concatenated onto them here",
  ],
  [
    "src/modules/storage/storage.service.ts",
    "getFileKeyFromUrl PARSES a stored legacy URL back to its key; it strips the base, never appends to it. The minting counterpart (publicUrlFor) was deleted in ticket 33 and storage-tenant-private.spec.ts pins its absence",
  ],
  [
    "src/modules/feedbucket/feedbucket-ai.service.ts",
    "getAllowedStorageHost derives a hostname to ALLOWLIST an outbound fetch of a legacy stored screenshot URL; it produces a host, not a URL, and new screenshots are read from the object store by key",
  ],
  [
    "src/modules/email/branding.ts",
    "getEmailLogoUrl builds a public URL for a static, operator-configured brand asset (EMAIL_LOGO_PATH, default email-assets/logo-v2.png). No tenant data and no uploaded object reaches it, and an email client cannot present a signed URL",
  ],
  [
    "src/scripts/setup-r2-buckets.ts",
    "operator setup script: prints guidance telling the operator which env var to set; no runtime path",
  ],
  [
    "src/scripts/legal-hold-drill-observations.ts",
    "INERT_STORAGE_CONFIG pins every storage field to an unreachable placeholder (endpoint and public base are both http://127.0.0.1:1, a closed port) so the legal-hold drill cannot reach an object store at all; the field is a constant, never concatenated with a key",
  ],
]);

const UPLOAD_RESULT_TYPE_RE =
  /\b(?:export\s+)?(?:interface|type)\s+(\w*Upload\w*(?:Result|Response)|\w*(?:Result|Response)\w*Upload\w*)\b/;

// -- helpers -----------------------------------------------------------------

/**
 * Blanks comments and string bodies but KEEPS the interior of a `${…}`
 * interpolation, because that is the exact shape a minted URL takes:
 * `` `${base}/${key}` ``. Blanking the whole template literal — which is what a
 * naive stripper does — makes this gate blind to the only pattern it is here to
 * catch, so the interpolation is treated as code and the literal text around it
 * as string.
 */
export function stripCommentsAndStrings(src) {
  const out = [];
  let i = 0;
  let inBlock = false;
  let inString = null;
  const templateStack = [];

  while (i < src.length) {
    const ch = src[i];

    if (inBlock) {
      if (ch === "*" && src[i + 1] === "/") {
        out.push(" ", " ");
        i += 2;
        inBlock = false;
      } else {
        out.push(ch === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    if (inString !== null) {
      if (ch === "\\") {
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (inString === "`" && ch === "$" && src[i + 1] === "{") {
        out.push(" ", " ");
        i += 2;
        templateStack.push({ depth: 1 });
        inString = null;
        continue;
      }
      if (ch === inString) {
        out.push(" ");
        inString = null;
        i++;
        continue;
      }
      out.push(ch === "\n" ? "\n" : " ");
      i++;
      continue;
    }

    if (ch === "/" && src[i + 1] === "*") {
      out.push(" ", " ");
      i += 2;
      inBlock = true;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out.push(" ");
      i++;
      continue;
    }

    const frame = templateStack[templateStack.length - 1];
    if (frame !== undefined) {
      if (ch === "{") frame.depth++;
      else if (ch === "}") {
        frame.depth--;
        if (frame.depth === 0) {
          templateStack.pop();
          out.push(" ");
          inString = "`";
          i++;
          continue;
        }
      }
    }

    out.push(ch);
    i++;
  }

  return out.join("");
}

export function matchesPattern(filePath, pattern) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  return filePath === pattern;
}

export function allowlistReason(filePath, allowlist) {
  for (const [pattern, reason] of allowlist) {
    if (matchesPattern(filePath, pattern)) return reason;
  }
  return null;
}

// -- analysis ----------------------------------------------------------------

/**
 * Comments and string bodies are stripped first, so a doc comment naming the
 * env var is not a finding while `process.env.NEXT_PUBLIC_R2_PUBLIC_URL` is.
 * `publicUrl` is matched as a whole word so `publicUrlBase` or a longer
 * identifier containing it still counts, but `republicUrl` does not.
 */
export function findPublicBaseSites(src, filePath) {
  const stripped = stripCommentsAndStrings(src);
  const lines = stripped.split("\n");
  const re = new RegExp(`\\b(?:${PUBLIC_BASE_TOKENS.join("|")})\\b`);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]))
      results.push({ file: filePath, line: i + 1, kind: "public-base" });
  }
  return results;
}

/**
 * Finds a `url` member declared inside an upload-result type body. The body is
 * taken from the opening brace to the matching close, so a `url` on a
 * neighbouring unrelated type is not attributed here.
 */
export function findUploadResultUrlFields(src, filePath) {
  const stripped = stripCommentsAndStrings(src);
  const results = [];
  const lines = stripped.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const header = UPLOAD_RESULT_TYPE_RE.exec(lines[i]);
    if (!header) continue;

    const open = stripped.indexOf("{", stripped.split("\n").slice(0, i).join("\n").length);
    if (open === -1) continue;

    let depth = 0;
    let close = -1;
    for (let j = open; j < stripped.length; j++) {
      if (stripped[j] === "{") depth++;
      else if (stripped[j] === "}") {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close === -1) continue;

    const body = stripped.slice(open + 1, close);
    if (/(^|[\s;,{])url\s*[?]?\s*:/.test(body))
      results.push({
        file: filePath,
        line: i + 1,
        kind: "upload-result-url",
        typeName: header[1],
      });
  }

  return results;
}

// -- self-test ---------------------------------------------------------------

if (SELF_TEST) {
  const unknownFile = "src/modules/invoices/invoices.service.ts";
  const brandingFile = "src/modules/email/branding.ts";

  const mintSrc = [
    "const base = process.env.NEXT_PUBLIC_R2_PUBLIC_URL ?? '';",
    "return `${base}/${key}`;",
  ].join("\n");

  const kbMintSrc = "return `${this.config.R2_KB_PUBLIC_URL}/${folder}/${name}`;";

  const regionFieldSrc = "const base = storage.kbPublicUrl;";

  const commentOnlySrc = [
    "// NEXT_PUBLIC_R2_PUBLIC_URL is the public base we no longer use",
    "return this.storage.getFileUrl(orgId, key, 900);",
  ].join("\n");

  const stringOnlySrc = 'const name = "NEXT_PUBLIC_R2_PUBLIC_URL";';

  const signedOnlySrc = [
    "const url = await getSignedUrl(client, command, { expiresIn: 900 });",
    "return { url };",
  ].join("\n");

  const uploadResultWithUrlSrc = [
    "export interface UploadResult {",
    "  key: string;",
    "  url: string;",
    "  size: number;",
    "}",
  ].join("\n");

  const uploadResultOptionalUrlSrc = [
    "export interface KbMediaUploadResult {",
    "  key: string;",
    "  url?: string;",
    "}",
  ].join("\n");

  const uploadResultCleanSrc = [
    "export interface UploadJobResult {",
    "  key: string;",
    "  mimeType: string;",
    "}",
  ].join("\n");

  const neighbouringTypeSrc = [
    "export interface UploadJobResult {",
    "  key: string;",
    "}",
    "export interface WebhookTarget {",
    "  url: string;",
    "}",
  ].join("\n");

  const urlInCommentSrc = [
    "export interface UploadResult {",
    "  key: string;",
    "  // url: string;  removed in ticket 33",
    "}",
  ].join("\n");

  const checks = {
    mintSiteFound: findPublicBaseSites(mintSrc, unknownFile).length === 1,
    kbMintSiteFound: findPublicBaseSites(kbMintSrc, unknownFile).length === 1,
    regionConfigFieldFound: findPublicBaseSites(regionFieldSrc, unknownFile).length === 1,
    commentReferenceNotFlagged: findPublicBaseSites(commentOnlySrc, unknownFile).length === 0,
    stringLiteralReferenceNotFlagged: findPublicBaseSites(stringOnlySrc, unknownFile).length === 0,
    signedUrlNotFlagged: findPublicBaseSites(signedOnlySrc, unknownFile).length === 0,
    unknownFileNotAllowlisted: allowlistReason(unknownFile, MINT_ALLOWLIST) === null,
    brandingAllowlistedWithReason:
      (allowlistReason(brandingFile, MINT_ALLOWLIST) ?? "").length > 20,
    everyAllowlistEntryHasReason: [...MINT_ALLOWLIST.values()].every(
      (r) => typeof r === "string" && r.trim().length > 0,
    ),
    uploadResultUrlFlagged:
      findUploadResultUrlFields(uploadResultWithUrlSrc, unknownFile).length === 1,
    uploadResultOptionalUrlFlagged:
      findUploadResultUrlFields(uploadResultOptionalUrlSrc, unknownFile).length === 1,
    uploadResultWithoutUrlClean:
      findUploadResultUrlFields(uploadResultCleanSrc, unknownFile).length === 0,
    neighbouringTypeUrlNotAttributed:
      findUploadResultUrlFields(neighbouringTypeSrc, unknownFile).length === 0,
    urlInCommentNotFlagged:
      findUploadResultUrlFields(urlInCommentSrc, unknownFile).length === 0,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

// -- run ---------------------------------------------------------------------

for (const [pattern, reason] of MINT_ALLOWLIST) {
  if (!reason || !reason.trim()) {
    process.stderr.write(`BROKEN ALLOWLIST: entry "${pattern}" has no reason\n`);
    process.exit(2);
  }
}

if (!existsSync(SCAN_ROOT)) {
  process.stderr.write(`Cannot read scan root: ${SCAN_ROOT}\n`);
  process.exit(2);
}

function walkTs(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTs(full));
    else if (entry.name.endsWith(".ts") && !SPEC_RE.test(entry.name)) results.push(full);
  }
  return results;
}

const mintSites = [];
const urlFieldSites = [];
let scanned = 0;

for (const file of walkTs(SCAN_ROOT)) {
  const rel = relative(BACKEND_ROOT, file).replace(/\\/g, "/");
  const src = readFileSync(file, "utf8");
  scanned++;
  for (const f of findPublicBaseSites(src, rel)) mintSites.push(f);
  for (const f of findUploadResultUrlFields(src, rel)) urlFieldSites.push(f);
}

if (!EXTERNAL_ROOT && mintSites.length < MIN_PUBLIC_BASE_SITES) {
  process.stderr.write(
    `Found only ${mintSites.length} public-base reference(s) in ${scanned} file(s). ` +
      `That is a broken pattern (renamed env var?), not a clean codebase.\n`,
  );
  process.exit(2);
}

const excused = mintSites.filter((f) => allowlistReason(f.file, MINT_ALLOWLIST) !== null);
const violations = mintSites.filter((f) => allowlistReason(f.file, MINT_ALLOWLIST) === null);

console.log(`check-public-object-urls: scanned ${scanned} source file(s)`);
console.log(`  public-base references   ${mintSites.length} (${excused.length} declared)`);
console.log(`  upload-result url fields ${urlFieldSites.length}`);
console.log("");

const declaredFiles = [...new Set(excused.map((f) => f.file))];
if (declaredFiles.length > 0) {
  console.log("DECLARED — each reads a public base for a stated non-minting reason:");
  for (const file of declaredFiles.sort())
    console.log(`  SKIP  ${file}  — ${allowlistReason(file, MINT_ALLOWLIST)}`);
  console.log("");
}

if (violations.length === 0 && urlFieldSites.length === 0) {
  console.log("OK — no upload path mints a permanent public URL, and no upload result carries one.");
  process.exit(0);
}

for (const f of violations.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`)))
  console.error(`  FAIL  [public-base]  ${f.file}:${f.line} — not on MINT_ALLOWLIST`);
for (const f of urlFieldSites.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`)))
  console.error(`  FAIL  [upload-result-url]  ${f.file}:${f.line} — ${f.typeName} declares a \`url\` member`);

console.error("");
console.error(
  `FAIL — ${violations.length} undeclared public-base reference(s), ` +
    `${urlFieldSites.length} upload result(s) declaring \`url\`.`,
);
process.exit(1);
