import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = 'src/modules';
const MY_MODULES = ['timesheets', 'directory'];
const STATEMENT_MAX_LINES = 120;

function statementFrom(lines, start) {
  const collected = [];
  for (let i = start; i < lines.length && i < start + STATEMENT_MAX_LINES; i++) {
    collected.push(lines[i]);
    if (/;\s*$/.test(lines[i])) break;
  }
  return collected.join('\n');
}

function projectsOnlyAggregates(chain) {
  const start = chain.indexOf('.select(');
  if (start === -1) return false;
  const fromAt = chain.indexOf('.from(', start);
  const projection = chain.slice(start, fromAt === -1 ? chain.length : fromAt);
  return /\b(count|sum|avg|min|max)\s*\(/i.test(projection);
}

function isUnboundedSelect(src) {
  const lines = src.split('\n');
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\.select\(/.test(line) && !/.limit\(/.test(line)) {
      const lookahead = statementFrom(lines, i);
      if (!/.limit\(/.test(lookahead) && !/\.findMany\(/.test(lookahead) && !projectsOnlyAggregates(lookahead)) {
        violations.push({ lineNo: i + 1, text: line.trim() });
      }
    }
    if (/\.findMany\(/.test(line)) {
      const lookahead = lines.slice(i, i + 10).join('\n');
      if (!/"take":|take\s*:|\blimit\b/.test(lookahead)) violations.push({ lineNo: i + 1, text: line.trim() });
    }
  }
  return violations;
}

function collectServiceFiles(dir) {
  const files = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return files; }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) files.push(...collectServiceFiles(full));
    else if (s.isFile() && extname(entry) === '.ts' && !entry.endsWith('.spec.ts') && !entry.endsWith('.module.ts') && !entry.endsWith('.controller.ts') && !entry.endsWith('.decorator.ts') && !entry.endsWith('.guard.ts') && !entry.endsWith('.interceptor.ts')) files.push(full);
  }
  return files;
}

for (const mod of MY_MODULES) {
  for (const file of collectServiceFiles(join(ROOT, mod))) {
    const src = readFileSync(file, 'utf8');
    const violations = isUnboundedSelect(src);
    if (violations.length > 0) {
      const relPath = file.replace(/\\/g, '/').replace('src/modules', '');
      console.log(relPath + ':');
      for (const v of violations) console.log('  L' + v.lineNo + ': ' + v.text.slice(0, 100));
    }
  }
}
