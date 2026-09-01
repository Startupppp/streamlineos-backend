export const EMAIL_TEMPLATE_VERSION = 1 as const;

/**
 * Deterministic locale fallback chain: exact locale → base language → "en".
 *
 * "en-GB" tries "en-GB" first, then "en", then returns the "en" value from the
 * map (which is the required baseline — template authors must always provide "en").
 * An unknown locale never throws and never returns an empty string as long as "en"
 * is present.
 */
export function resolveLocaleText(locale: string, map: Record<string, string>): string {
  if (Object.prototype.hasOwnProperty.call(map, locale)) return map[locale] as string;
  const base = locale.split("-")[0] ?? "";
  if (base && base !== locale && Object.prototype.hasOwnProperty.call(map, base))
    return map[base] as string;
  return (map["en"] as string) ?? "";
}
