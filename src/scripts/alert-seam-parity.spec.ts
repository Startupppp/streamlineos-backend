import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listSeams, type SeamBudget } from '../common/observability/seam-budgets';

interface ParityMismatch {
  key: string;
  scriptThreshold: number;
  budgetThreshold: number;
}

interface ParityResult {
  parsedCount: number;
  missingInScript: string[];
  missingInBudgets: string[];
  mismatches: ParityMismatch[];
  seamAttributeKey: string | null;
}

export function extractSeamAttributeKey(scriptText: string): string | null {
  const match = scriptText.match(/const SEAM_ATTRIBUTE_KEY\s*=\s*"([^"]+)"/);
  const key = match?.[1];
  return key !== undefined ? key : null;
}

export function checkParity(scriptText: string, budgets: readonly SeamBudget[]): ParityResult {
  const blockMatch = scriptText.match(/const SEAM_BUDGETS\s*=\s*\{([^}]+)\}/);
  const blockContent = blockMatch?.[1] ?? '';

  const scriptThresholds = new Map<string, number>();
  const entryPattern = /"([^"]+)":\s*([\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(blockContent)) !== null) {
    const rawKey = match[1];
    const rawVal = match[2];
    if (rawKey !== undefined && rawVal !== undefined) {
      scriptThresholds.set(rawKey, Number(rawVal));
    }
  }

  const budgetKeySet = new Set<string>(budgets.map((b) => b.key));
  const scriptKeySet = new Set(scriptThresholds.keys());

  const missingInScript = [...budgetKeySet].filter((k) => !scriptKeySet.has(k));
  const missingInBudgets = [...scriptKeySet].filter((k) => !budgetKeySet.has(k));

  const mismatches: ParityMismatch[] = [];
  for (const budget of budgets) {
    const scriptThreshold = scriptThresholds.get(budget.key);
    if (scriptThreshold === undefined) continue;
    if (scriptThreshold !== budget.thresholdMs) {
      mismatches.push({ key: budget.key, scriptThreshold, budgetThreshold: budget.thresholdMs });
    }
  }

  return {
    parsedCount: scriptThresholds.size,
    missingInScript,
    missingInBudgets,
    mismatches,
    seamAttributeKey: extractSeamAttributeKey(scriptText),
  };
}

describe('alert-seam-parity', () => {
  const scriptPath = join(__dirname, 'alert-seam-latency.mjs');
  const scriptText = readFileSync(scriptPath, 'utf-8');
  const budgets = listSeams();

  describe('against the real script', () => {
    it('parses at least as many thresholds as there are seam budgets (anti-vacuous)', () => {
      const result = checkParity(scriptText, budgets);
      expect(result.parsedCount).toBeGreaterThanOrEqual(budgets.length);
    });

    it('every seam in SEAM_BUDGETS appears in the script threshold table', () => {
      const result = checkParity(scriptText, budgets);
      expect(result.missingInScript).toEqual([]);
    });

    it('every seam in the script threshold table exists in SEAM_BUDGETS', () => {
      const result = checkParity(scriptText, budgets);
      expect(result.missingInBudgets).toEqual([]);
    });

    it('every threshold number matches exactly', () => {
      const result = checkParity(scriptText, budgets);
      expect(result.mismatches).toEqual([]);
    });

    it('SEAM_ATTRIBUTE_KEY is exactly "seam"', () => {
      expect(extractSeamAttributeKey(scriptText)).toBe('seam');
    });
  });

  describe('against synthetic mismatched fixtures', () => {
    it('reports a mismatch when one threshold number differs', () => {
      const synthetic = [
        'const SEAM_ATTRIBUTE_KEY = "seam";',
        'const SEAM_BUDGETS = {',
        '  "db.pool.wait": 3,',
        '  "db.guc.setup": 2,',
        '  "db.query.execute": 9,',
        '  "db.roundtrip.simple": 15,',
        '  "db.roundtrip.complex": 37,',
        '  "cache.roundtrip": 1.5,',
        '  "route.cached.read": 112,',
        '  "route.write": 999,',
        '  "runtime.eventloop.delay": 37,',
        '};',
      ].join('\n');
      const result = checkParity(synthetic, budgets);
      expect(result.mismatches.some((m) => m.key === 'route.write')).toBe(true);
      const routeWriteMismatch = result.mismatches.find((m) => m.key === 'route.write');
      expect(routeWriteMismatch?.scriptThreshold).toBe(999);
      expect(routeWriteMismatch?.budgetThreshold).toBe(375);
    });

    it('reports missing script keys when a seam is absent from the fixture', () => {
      const synthetic = [
        'const SEAM_ATTRIBUTE_KEY = "seam";',
        'const SEAM_BUDGETS = {',
        '  "db.pool.wait": 3,',
        '};',
      ].join('\n');
      const result = checkParity(synthetic, budgets);
      expect(result.missingInScript.length).toBeGreaterThan(0);
      expect(result.missingInScript).toContain('runtime.eventloop.delay');
    });

    it('detects a wrong SEAM_ATTRIBUTE_KEY value', () => {
      const synthetic = [
        'const SEAM_ATTRIBUTE_KEY = "seamName";',
        'const SEAM_BUDGETS = {};',
      ].join('\n');
      expect(extractSeamAttributeKey(synthetic)).toBe('seamName');
    });

    it('parsedCount is zero for an empty block (anti-vacuous guard triggers on real script)', () => {
      const emptyBlock = 'const SEAM_BUDGETS = {};';
      const result = checkParity(emptyBlock, budgets);
      expect(result.parsedCount).toBe(0);
      expect(result.parsedCount).toBeLessThan(budgets.length);
    });
  });
});
