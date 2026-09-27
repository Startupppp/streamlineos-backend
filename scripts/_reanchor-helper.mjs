// Throwaway helper - find correct line numbers for stale anchors
// Delete after use
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const FENCED = "src/modules/build/core/";

// Read the REVIEWED_INLINE entries by importing the gate directly won't work
// (it's a top-level await). Instead, re-extract them by parsing the raw source.
// We'll use a manual approach: evaluate the relevant parts.

// Load the census script source and extract REVIEWED_INLINE manually.
const src = readFileSync(join(SCRIPT_DIR, "build-authorization-census.mjs"), "utf8");

// We need to collect evidence entries from the script to identify each one.
// Rather than full AST parse, we'll just run the validation logic ourselves.

// Re-read each evidence file and check each regex.
// We need the same REVIEWED_INLINE data - but since we can't import it due to top-level await,
// let's just re-implement the stale detection inline with the data.

// Actually the approach: use the error output from the main run which lists file:line pairs,
// then for each stale anchor, search the file to find where the regex currently matches.

// The gate script tells us:
//   key: anchor no longer matches file:line
//   expected /regex/
//   found    text

// We need to find: where in file does /regex/ match?

// Parse the census output to get the failing entries
import { spawnSync } from "node:child_process";

const result = spawnSync("node", [join(SCRIPT_DIR, "build-authorization-census.mjs")], {
  encoding: "utf8",
  cwd: REPO_ROOT,
  maxBuffer: 10 * 1024 * 1024,
});

const output = (result.stderr || "") + (result.stdout || "");
const lines = output.split("\n");

const fixes = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i].trim();
  
  const missingMatch = line.match(/^(\S+): evidence file missing: (.+)$/);
  if (missingMatch) {
    const file = missingMatch[2];
    if (!file.startsWith(FENCED)) {
      fixes.push({ type: "missing", key: missingMatch[1], file });
    }
    i++;
    continue;
  }
  
  const staleMatch = line.match(/^(\S+): anchor no longer matches (.+):(\d+)$/);
  if (staleMatch) {
    const key = staleMatch[1];
    const file = staleMatch[2];
    const oldLine = parseInt(staleMatch[3]);
    const expectedLine = lines[i + 1]?.trim() || "";
    const foundLine = lines[i + 2]?.trim() || "";
    
    if (expectedLine.startsWith("expected ")) {
      const regexStr = expectedLine.slice("expected ".length);
      
      if (!file.startsWith(FENCED)) {
        // Search the file for where the regex now matches
        const absFile = join(REPO_ROOT, file);
        let fileLines;
        try {
          fileLines = readFileSync(absFile, "utf8").split(/\r?\n/);
        } catch {
          fixes.push({ type: "file_gone", key, file, oldLine, regexStr });
          i += 3;
          continue;
        }
        
        // Parse the regex string back into a RegExp
        // The regexStr looks like: /pattern/flags or just text
        let regex;
        const rxMatch = regexStr.match(/^\/(.*)\/([gimsuy]*)$/);
        if (rxMatch) {
          try {
            regex = new RegExp(rxMatch[1], rxMatch[2]);
          } catch {
            regex = null;
          }
        }
        
        if (!regex) {
          fixes.push({ type: "unparseable_regex", key, file, oldLine, regexStr });
          i += 3;
          continue;
        }
        
        const matches = [];
        for (let j = 0; j < fileLines.length; j++) {
          if (regex.test(fileLines[j])) {
            matches.push(j + 1); // 1-indexed
          }
        }
        
        if (matches.length === 0) {
          fixes.push({ type: "regex_not_found", key, file, oldLine, regexStr });
        } else if (matches.length === 1) {
          fixes.push({ type: "fix", key, file, oldLine, newLine: matches[0] });
        } else {
          // Multiple matches - pick closest to old line
          const closest = matches.reduce((a, b) => Math.abs(a - oldLine) < Math.abs(b - oldLine) ? a : b);
          fixes.push({ type: "fix_multi", key, file, oldLine, newLine: closest, allMatches: matches });
        }
      }
      i += 3;
      continue;
    }
  }
  i++;
}

console.log(JSON.stringify(fixes, null, 2));
