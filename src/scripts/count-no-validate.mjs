import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const S08_DIRS = [
  "src/modules/dashboard",
  "src/modules/cron",
  "src/modules/audit-log",
  "src/modules/storage",
  "src/modules/ingress",
  "src/modules/activities",
  "src/modules/data-quality",
  "src/modules/public",
  "src/modules/portal",
  "src/modules/integrations",
];
const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;

function walk(dir) {
  const out = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else if (e.name.endsWith(".controller.ts") && !SPEC_RE.test(e.name)) out.push(full);
    }
  } catch {
    /* dir may not exist */
  }
  return out;
}

const results = [];

for (const base of S08_DIRS) {
  for (const fpath of walk(base)) {
    const src = readFileSync(fpath, "utf8");
    const lines = src.split("\n");
    const relPath = fpath.replace(/\\/g, "/");

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!/^\s*@/.test(line)) { i++; continue; }

      const blockStart = i;
      let j = i;
      const block = [];
      while (j < lines.length && (/^\s*@/.test(lines[j]) || lines[j].trim() === "")) {
        block.push(lines[j]);
        j++;
      }

      const blockText = block.join("\n");
      const hasHttp = /^\s*@(Get|Post|Put|Patch|Delete)\b/m.test(blockText);
      const hasValidate = /@Validate\s*\(/.test(blockText);

      const handlerText = lines.slice(j, Math.min(j + 12, lines.length)).join("\n");
      const hasNamedQuery = /@(?:Query|Param)\s*\(\s*["']/.test(blockText + handlerText);
      const hasPipe = /ParseIntPipe|ParseBoolPipe/.test(handlerText);

      if (hasHttp && !hasValidate && (hasNamedQuery || hasPipe)) {
        const methodMatch = (lines[j] || "").match(/(?:async\s+)?(\w+)\s*\(/);
        const method = methodMatch ? methodMatch[1] : "?";
        results.push(`${relPath}:${blockStart + 1} ${method}`);
      }

      i = j + 1;
    }
  }
}

console.log(`Within S08 ownership — handlers with named params/pipes but no @Validate: ${results.length}`);
results.forEach((r) => console.log(`  ${r}`));
