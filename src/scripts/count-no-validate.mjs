import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MODULES_DIR = "src/modules";
const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".controller.ts") && !SPEC_RE.test(e.name)) out.push(full);
  }
  return out;
}

const results = [];

for (const fpath of walk(MODULES_DIR)) {
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
    const hasPipe = /ParseIntPipe|ParseBoolPipe|ParseUUIDPipe|ParseEnumPipe/.test(handlerText);

    if (hasHttp && !hasValidate && (hasNamedQuery || hasPipe)) {
      const methodMatch = (lines[j] || "").match(/(?:async\s+)?(\w+)\s*\(/);
      const method = methodMatch ? methodMatch[1] : "?";
      results.push(`${relPath}:${blockStart + 1} ${method}`);
    }

    i = j + 1;
  }
}

console.log(`Total: ${results.length}`);
results.forEach((r) => console.log(`  ${r}`));
