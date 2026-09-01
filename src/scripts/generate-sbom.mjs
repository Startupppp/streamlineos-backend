#!/usr/bin/env node
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SELF_TEST = process.argv.includes("--self-test");
const OUT = resolve(ROOT, "sbom.json");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function buildCycloneDXComponent(name, version, licenseId, purl) {
  return {
    type: "library",
    name,
    version,
    purl,
    licenses: licenseId ? [{ license: { id: licenseId } }] : [],
  };
}

if (SELF_TEST) {
  const mockPkg = { name: "test-lib", version: "1.0.0" };
  const comp = buildCycloneDXComponent(mockPkg.name, mockPkg.version, "MIT", `pkg:npm/${mockPkg.name}@${mockPkg.version}`);
  if (comp.type !== "library" || comp.name !== "test-lib" || comp.licenses[0]?.license?.id !== "MIT") {
    process.stderr.write("SELF-TEST FAILED: component builder returned unexpected shape.\n");
    process.stderr.write(JSON.stringify(comp, null, 2) + "\n");
    process.exit(1);
  }
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.4",
    serialNumber: `urn:uuid:self-test`,
    version: 1,
    components: [comp],
  };
  const serialized = JSON.stringify(sbom, null, 2);
  const hash = sha256(serialized);
  if (!hash || hash.length !== 64) {
    process.stderr.write(`SELF-TEST FAILED: bad sha256 output: ${hash}\n`);
    process.exit(1);
  }
  process.stdout.write(`SELF-TEST PASSED: CycloneDX SBOM builder and SHA-256 are working.\n`);
  process.stdout.write(`  sha256=${hash}\n`);
  process.exit(0);
}

process.stdout.write("[sbom:generate] Collecting dependency metadata via pnpm licenses...\n");

let licenseRaw;
try {
  licenseRaw = execSync("pnpm licenses list --json", {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
} catch (err) {
  process.stderr.write(`[sbom:generate] pnpm licenses failed:\n${err.stderr ?? err.message}\n`);
  process.exit(1);
}

let licensesByType;
try {
  licensesByType = JSON.parse(licenseRaw);
} catch {
  process.stderr.write("[sbom:generate] Could not parse pnpm licenses JSON.\n");
  process.exit(1);
}

const components = [];
for (const [licenseId, packages] of Object.entries(licensesByType)) {
  for (const pkg of packages) {
    const name = pkg.name;
    const version = (pkg.versions ?? [])[0] ?? "unknown";
    const purl = `pkg:npm/${name}@${version}`;
    components.push(buildCycloneDXComponent(name, version, licenseId, purl));
  }
}

const backendPkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.4",
  serialNumber: `urn:uuid:${crypto.randomUUID?.() ?? Date.now().toString(16)}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      name: backendPkg.name,
      version: backendPkg.version,
    },
  },
  components,
};

const serialized = JSON.stringify(sbom, null, 2);
const hash = sha256(serialized);

writeFileSync(OUT, serialized, "utf8");

process.stdout.write(`[sbom:generate] SBOM written to ${OUT}\n`);
process.stdout.write(`[sbom:generate] Components: ${components.length}\n`);
process.stdout.write(`[sbom:generate] sha256:${hash}\n`);
