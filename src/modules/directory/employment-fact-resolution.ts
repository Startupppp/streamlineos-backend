export type FactResolution<T> = {
  value: T | null;
  usedFallback: boolean;
  disagreed: boolean;
};

function absent(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function agree(canonical: unknown, legacy: unknown): boolean {
  if (typeof canonical === "object" || typeof legacy === "object")
    return JSON.stringify(canonical) === JSON.stringify(legacy);
  return canonical === legacy;
}

export function resolveFact<T>(canonical: T | null, legacy: T | null): FactResolution<T> {
  if (absent(canonical)) {
    if (absent(legacy)) return { value: null, usedFallback: false, disagreed: false };
    return { value: legacy, usedFallback: true, disagreed: false };
  }
  if (absent(legacy)) return { value: canonical, usedFallback: false, disagreed: false };
  return {
    value: canonical,
    usedFallback: false,
    disagreed: !agree(canonical, legacy),
  };
}
