import { MODULES } from "./benchmark-modules.mjs";

const EXCLUDED_DOMAINS = ["crm", "inventory"];
const CRM_SEARCH = new Set([
  "search-lead-party-sdf",
  "search-deal-sdf",
  "search-contact-party-sdf",
  "search-client-party-sdf",
]);

export function buildCodeReleaseScope() {
  const included = [];
  const excluded = [];
  for (const module of MODULES) {
    const benchmarks = [
      ...Object.keys(module.readCostBudgets).map((id) => ({ id, source: "read-cost-budgets.mjs" })),
      ...module.heavyQueries.map((id) => ({ id, source: "heavy-query-catalog.mjs" })),
    ];
    for (const benchmark of benchmarks) {
      const entry = { module: module.id, ...benchmark };
      const domain = EXCLUDED_DOMAINS.includes(module.id)
        ? module.id
        : CRM_SEARCH.has(benchmark.id) ? "crm" : null;
      if (domain) excluded.push({ ...entry, reason: `${domain} is excluded from the code release` });
      else included.push(entry);
    }
  }
  return { id: "code-release", excludedDomains: [...EXCLUDED_DOMAINS], included, excluded };
}

const keyOf = (entry) => `${entry.module}/${entry.source}/${entry.id}`;

export function validateCodeReleaseScope(manifest) {
  const expected = buildCodeReleaseScope();
  const scope = manifest.codeReleaseScope;
  if (!scope || typeof scope !== "object") return ["codeReleaseScope is missing"];
  const errors = [];
  if (scope.id !== expected.id || JSON.stringify(scope.excludedDomains) !== JSON.stringify(expected.excludedDomains))
    errors.push("codeReleaseScope must name exactly the CRM and Inventory exclusions");
  for (const field of ["included", "excluded"]) {
    if (!Array.isArray(scope[field])) {
      errors.push(`codeReleaseScope.${field} is missing`);
      continue;
    }
    const entries = scope[field];
    if (entries.some((entry) => !entry || typeof entry !== "object")) {
      errors.push(`codeReleaseScope.${field} contains an invalid entry`);
      continue;
    }
    const actual = new Map(entries.map((entry) => [keyOf(entry), entry]));
    if (actual.size !== entries.length) errors.push(`codeReleaseScope.${field} contains duplicate entries`);
    const wanted = new Set(expected[field].map(keyOf));
    for (const entry of expected[field]) {
      const key = keyOf(entry);
      if (!actual.has(key)) errors.push(`codeReleaseScope.${field} is missing ${key}`);
      else if (field === "excluded" && actual.get(key).reason !== entry.reason)
        errors.push(`codeReleaseScope.excluded has an invalid reason for ${key}`);
    }
    for (const key of actual.keys())
      if (!wanted.has(key)) errors.push(`codeReleaseScope.${field} contains unexpected ${key}`);
  }
  const captured = new Set((manifest.modules ?? []).flatMap((module) =>
    (module.benchmarks ?? []).map((benchmark) => keyOf({ module: module.id, ...benchmark })),
  ));
  for (const entry of [...expected.included, ...expected.excluded])
    if (!captured.has(keyOf(entry))) errors.push(`global benchmark capture is missing ${keyOf(entry)}`);
  return errors;
}
