export type LocalizedValues<T> = { en: T } & Record<string, T>;

function canonicalLocale(locale: string): string {
  return locale.trim().replace("_", "-").toLowerCase();
}

export function resolveAvailableLocale(
  preferredLocale: string,
  availableLocales: readonly string[],
): string | undefined {
  const byCanonical = new Map(
    availableLocales.map((locale) => [canonicalLocale(locale), locale]),
  );
  const preferred = canonicalLocale(preferredLocale);
  const exact = byCanonical.get(preferred);
  if (exact) return exact;
  const base = preferred.split("-")[0] ?? "";
  const baseMatch = byCanonical.get(base);
  if (baseMatch) return baseMatch;
  return byCanonical.get("en");
}

export function resolveLocaleValue<T>(locale: string, map: LocalizedValues<T>): T {
  const resolved = resolveAvailableLocale(locale, Object.keys(map));
  return resolved === undefined ? map.en : (map[resolved] ?? map.en);
}
