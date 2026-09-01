#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SELF_TEST = process.argv.includes("--self-test");

const targetArg = process.argv.find((a) => a.startsWith("--dir="));
const TARGET_DIR = targetArg ? resolve(targetArg.slice("--dir=".length)) : resolve(ROOT, "dist");

const outArg = process.argv.find((a) => a.startsWith("--out="));
const OUT = outArg ? resolve(outArg.slice("--out=".length)) : resolve(ROOT, "artifact-hashes.json");

function sha256File(filePath) {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function collectFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) results.push(...collectFiles(full));
    else results.push(full);
  }
  return results;
}

if (SELF_TEST) {
  const testContent = Buffer.from("streamlineos-artifact-hash-self-test", "utf8");
  const expectedHash = createHash("sha256").update(testContent).digest("hex");
  const testFile = join(ROOT, "_hash-self-test.tmp");
  writeFileSync(testFile, testContent);
  const got = sha256File(testFile);
  const { unlinkSync } = await import("node:fs");
  unlinkSync(testFile);
  if (got !== expectedHash) {
    process.stderr.write(`SELF-TEST FAILED: expected ${expectedHash}, got ${got}\n`);
    process.exit(1);
  }
  process.stdout.write(`SELF-TEST PASSED: SHA-256 of a file matches expected digest.\n`);
  process.stdout.write(`  sha256:${got}\n`);
  process.exit(0);
}

const { existsSync } = await import("node:fs");
if (!existsSync(TARGET_DIR)) {
  process.stderr.write(`[artifact:record-hashes] Target directory does not exist: ${TARGET_DIR}\n`);
  process.stderr.write(`  Run \`pnpm build\` first, then \`pnpm artifact:record-hashes\`.\n`);
  process.exit(1);
}

const files = collectFiles(TARGET_DIR);
if (files.length === 0) {
  process.stderr.write(`[artifact:record-hashes] No files found in ${TARGET_DIR}.\n`);
  process.exit(1);
}

const hashes = {};
for (const f of files) {
  const rel = relative(TARGET_DIR, f).replace(/\\/g, "/");
  hashes[rel] = sha256File(f);
}

const manifest = {
  generatedAt: new Date().toISOString(),
  sourceDir: TARGET_DIR,
  fileCount: files.length,
  hashes,
};
const serialized = JSON.stringify(manifest, null, 2);
writeFileSync(OUT, serialized, "utf8");

process.stdout.write(`[artifact:record-hashes] Recorded ${files.length} file(s) to ${OUT}\n`);
process.stdout.write(`[artifact:record-hashes] manifest-sha256:${createHash("sha256").update(serialized).digest("hex")}\n`);
