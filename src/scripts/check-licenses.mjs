#!/usr/bin/env node
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SELF_TEST = process.argv.includes("--self-test");

const DISALLOWED_LICENSE_PATTERNS = [
  /^GPL-[0-9]/i,
  /^AGPL-[0-9]/i,
  /^LGPL-[0-9]/i,
  /^SSPL/i,
  /^BUSL/i,
  /^Commons Clause/i,
  /^Proprietary/i,
];

/**
 * Reviewed exceptions to DISALLOWED_LICENSE_PATTERNS, keyed by package name.
 *
 * Each entry states the license, the mechanism by which the component is used, the specific
 * licence term the exemption rests on, and its review status. The two LGPL entries below rest
 * on DIFFERENT arguments and must not be collapsed into one: ffmpeg is a subprocess and is
 * never linked; libvips is dynamically linked into a native addon in our own process. Copying
 * the subprocess reasoning onto the linked case would be false.
 */
const LICENSE_EXCEPTIONS = new Map([
  [
    "@ffmpeg-installer/ffmpeg",
    "LGPL-2.1 — FFmpeg binary invoked via child_process (subprocess call, not library linking); LGPL copyleft does not extend to the calling application. Reviewed 2026-09-01.",
  ],
  [
    "@img/sharp-libvips-darwin-arm64",
    "LGPL-3.0-or-later — prebuilt libvips shared library (lib/libvips-cpp.8.18.3.dylib), the darwin-arm64 platform binary of `sharp`. " +
      "IN USE IN PRODUCTION: sharp is imported by src/common/media/media-compression.service.ts (provided by StorageModule) and " +
      "src/modules/kb/wiki/kb-media.service.ts (behind KbMediaController); `pnpm exec knip` reports it as a used dependency, so removal is not available. " +
      "MECHANISM — dynamic linking, NOT the ffmpeg subprocess argument: libvips is linked into sharp's native addon in our own process. " +
      "Measured on disk 2026-09-03: `otool -L @img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.3.node` resolves `@rpath/libvips-cpp.8.18.3.dylib`. " +
      "ARGUMENT — LGPL-3.0 §4 (Combined Works): a work that uses the library may be conveyed under terms of our choosing when the combination uses a " +
      "shared library mechanism and the LGPL component remains separately replaceable. It does here — the .dylib ships as its own npm package resolved " +
      "at load time via @rpath and can be swapped for another build of libvips without recompiling or relinking StreamlineOS code. " +
      "We modify no libvips source, copy none of it into the application, and the upstream package carries the LGPL text and source offer. " +
      "Copyleft therefore does not extend to StreamlineOS. This is the argument the sharp project itself relies on. " +
      "OWNER: PENDING LEGAL REVIEW — engineering assessment recorded 2026-09-03; NOT a legal sign-off. PRD-C182/C184 require named Legal approval " +
      "for a compliance decision, and no named approver exists for this entry yet. Removal trigger: sharp is dropped, libvips is statically linked into " +
      "the addon, or Legal declines.",
  ],
]);

function isDisallowed(licenseId) {
  return DISALLOWED_LICENSE_PATTERNS.some((p) => p.test(licenseId));
}

if (SELF_TEST) {
  const mockLicenses = {
    "MIT": [{ name: "safe-pkg", versions: ["1.0.0"] }],
    "Apache-2.0": [{ name: "also-safe", versions: ["2.0.0"] }],
    "GPL-3.0": [{ name: "gpl-pkg", versions: ["1.0.0"] }],
    "AGPL-3.0": [{ name: "agpl-pkg", versions: ["1.0.0"] }],
  };

  const violations = [];
  for (const [license, packages] of Object.entries(mockLicenses)) {
    if (isDisallowed(license)) {
      for (const pkg of packages) {
        violations.push({ license, pkg: pkg.name });
      }
    }
  }

  if (violations.length !== 2) {
    process.stderr.write(`SELF-TEST FAILED: expected 2 violations, got ${violations.length}.\n`);
    process.stderr.write(JSON.stringify(violations, null, 2) + "\n");
    process.exit(1);
  }
  const violationNames = violations.map((v) => v.pkg).sort();
  if (!violationNames.includes("gpl-pkg") || !violationNames.includes("agpl-pkg")) {
    process.stderr.write(`SELF-TEST FAILED: wrong packages in violations: ${JSON.stringify(violationNames)}\n`);
    process.exit(1);
  }
  process.stdout.write("SELF-TEST PASSED: license checker correctly identifies GPL/AGPL violations.\n");
  process.exit(0);
}

process.stdout.write("[check:licenses] Scanning production dependency licenses...\n");

let raw;
try {
  raw = execSync("pnpm licenses list --prod --json", {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
} catch (err) {
  process.stderr.write(`[check:licenses] pnpm licenses failed:\n${err.stderr ?? err.message}\n`);
  process.exit(1);
}

let licenses;
try {
  licenses = JSON.parse(raw);
} catch {
  process.stderr.write(`[check:licenses] Could not parse pnpm licenses JSON.\n`);
  process.exit(1);
}

const violations = [];
const exceptions = [];
for (const [licenseId, packages] of Object.entries(licenses)) {
  if (isDisallowed(licenseId)) {
    for (const pkg of packages) {
      if (LICENSE_EXCEPTIONS.has(pkg.name)) {
        exceptions.push({ licenseId, name: pkg.name, reason: LICENSE_EXCEPTIONS.get(pkg.name) });
      } else {
        violations.push({ licenseId, name: pkg.name, version: pkg.versions?.[0] ?? "?" });
      }
    }
  }
}

if (exceptions.length > 0) {
  process.stdout.write(`[check:licenses] ${exceptions.length} reviewed exception(s):\n`);
  for (const e of exceptions) {
    process.stdout.write(`  [${e.licenseId}] ${e.name}: ${e.reason}\n`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`[check:licenses] FAIL — ${violations.length} disallowed license(s) found:\n`);
  for (const v of violations) {
    process.stderr.write(`  [${v.licenseId}] ${v.name}@${v.version}\n`);
  }
  process.stderr.write("\nDisallowed pattern: GPL, AGPL, LGPL, SSPL, BUSL, Commons Clause, Proprietary.\n");
  process.stderr.write("Either remove the dependency or add a legal exception with documented justification.\n");
  process.exit(1);
}

process.stdout.write("[check:licenses] OK — no disallowed licenses in production dependencies.\n");
