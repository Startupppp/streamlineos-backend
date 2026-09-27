// Throwaway v2 - order-preserving re-anchor helper
// Delete after use
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const FENCED = "src/modules/build/core/";

// Load all REVIEWED data from the lane files
const LANE_VERDICT_PATTERN = /^census-verdicts-[a-z0-9-]+\.mjs$/;
const loaded = [];
for (const file of readdirSync(SCRIPT_DIR).filter(f => LANE_VERDICT_PATTERN.test(f)).sort()) {
  const mod = await import(pathToFileURL(join(SCRIPT_DIR, file)).href);
  for (const entry of mod.default) loaded.push({ ...entry, laneFile: file });
}

// Also extract REVIEWED_INLINE from the main census script
const censorSrc = readFileSync(join(SCRIPT_DIR, "build-authorization-census.mjs"), "utf8");
// We just run the validation ourselves by importing... wait can't, top-level await.
// Instead, eval the REVIEWED_INLINE portion. 

// Use a different approach: parse the error output from the main script.
import { spawnSync } from "node:child_process";
const result = spawnSync("node", [join(SCRIPT_DIR, "build-authorization-census.mjs")], {
  encoding: "utf8", cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024,
});
const output = (result.stderr || "") + (result.stdout || "");
const lines = output.split("\n");

// Parse failing anchors
const failures = []; // { key, file, oldLine, anchorStr }
let i = 0;
while (i < lines.length) {
  const line = lines[i].trim();
  const missingMatch = line.match(/^(\S+): evidence file missing: (.+)$/);
  if (missingMatch) {
    if (!missingMatch[2].startsWith(FENCED)) {
      failures.push({ key: missingMatch[1], file: missingMatch[2], oldLine: null, type: "missing" });
    }
    i++; continue;
  }
  const staleMatch = line.match(/^(\S+): anchor no longer matches (.+):(\d+)$/);
  if (staleMatch) {
    const key = staleMatch[1], file = staleMatch[2], oldLine = parseInt(staleMatch[3]);
    const expectedLine = lines[i + 1]?.trim() || "";
    if (expectedLine.startsWith("expected ") && !file.startsWith(FENCED)) {
      const regexStr = expectedLine.slice("expected ".length);
      const rxMatch = regexStr.match(/^\/(.*)\/([gimsuy]*)$/);
      let regex = null;
      if (rxMatch) { try { regex = new RegExp(rxMatch[1], rxMatch[2]); } catch {} }
      failures.push({ key, file, oldLine, anchorStr: regexStr, regex, type: "stale" });
    }
    i += 3; continue;
  }
  i++;
}

// For each (key, file) pair, gather all stale oldLines and find all regex matches
// Group by (key, file) to do order-preserving assignment
const byKeyFile = new Map();
for (const f of failures.filter(x => x.type === "stale")) {
  const k = `${f.key}||${f.file}`;
  if (!byKeyFile.has(k)) byKeyFile.set(k, []);
  byKeyFile.get(k).push(f);
}

const fixes = []; // { key, file, oldLine, newLine, anchorStr, regex }

for (const [k, group] of byKeyFile) {
  // Sort by oldLine
  group.sort((a, b) => a.oldLine - b.oldLine);
  
  // Find all matches for each distinct regex in this file
  const fileContent = (() => {
    try { return readFileSync(join(REPO_ROOT, group[0].file), "utf8").split(/\r?\n/); }
    catch { return null; }
  })();
  
  if (!fileContent) {
    for (const g of group) fixes.push({ ...g, newLine: null, error: "file_not_found" });
    continue;
  }
  
  // If all anchors in the group have the SAME regex, use order-preserving assignment
  const uniqueRegexStrs = [...new Set(group.map(g => g.anchorStr))];
  
  if (uniqueRegexStrs.length === 1 && group.length > 1) {
    // All same regex: find all matches, assign in order
    const regex = group[0].regex;
    if (!regex) {
      for (const g of group) fixes.push({ ...g, newLine: null, error: "unparseable_regex" });
      continue;
    }
    const allMatches = fileContent.map((l, idx) => regex.test(l) ? idx + 1 : null).filter(Boolean);
    if (allMatches.length === 0) {
      for (const g of group) fixes.push({ ...g, newLine: null, error: "regex_not_found" });
    } else if (allMatches.length < group.length) {
      // Fewer matches than needed - try closest for each
      for (const g of group) {
        const closest = allMatches.reduce((a, b) => Math.abs(a - g.oldLine) < Math.abs(b - g.oldLine) ? a : b);
        fixes.push({ ...g, newLine: closest, note: `fewer_matches(${allMatches.length}) of ${group.length}` });
      }
    } else {
      // Enough matches: assign in order (sorted old → sorted matches)
      const sorted = [...allMatches].sort((a, b) => a - b);
      for (let j = 0; j < group.length; j++) {
        // Find the j-th candidate that's closest to the old line while maintaining order
        fixes.push({ ...group[j], newLine: sorted[j] || sorted[sorted.length - 1] });
      }
    }
  } else {
    // Different regexes in the group: handle each separately
    for (const g of group) {
      if (!g.regex) { fixes.push({ ...g, newLine: null, error: "unparseable_regex" }); continue; }
      const allMatches = fileContent.map((l, idx) => g.regex.test(l) ? idx + 1 : null).filter(Boolean);
      if (allMatches.length === 0) { fixes.push({ ...g, newLine: null, error: "regex_not_found" }); continue; }
      const closest = allMatches.reduce((a, b) => Math.abs(a - g.oldLine) < Math.abs(b - g.oldLine) ? a : b);
      fixes.push({ ...g, newLine: closest, allMatches: allMatches.length > 1 ? allMatches : undefined });
    }
  }
}

// Output as JSON
const out = fixes.map(f => ({
  key: f.key, file: f.file, oldLine: f.oldLine, newLine: f.newLine,
  ...(f.error ? { error: f.error } : {}),
  ...(f.allMatches ? { allMatches: f.allMatches } : {}),
  ...(f.note ? { note: f.note } : {}),
}));

console.log(JSON.stringify(out, null, 2));
