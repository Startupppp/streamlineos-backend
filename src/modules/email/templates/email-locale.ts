export const EMAIL_TEMPLATE_VERSION = 1 as const;

export {
  resolveLocaleValue,
  type LocalizedValues,
} from "../../../common/i18n/locale-fallback";

import {
  resolveLocaleValue,
  type LocalizedValues,
} from "../../../common/i18n/locale-fallback";

/**
 * Deterministic locale fallback chain: exact locale → base language → "en".
 *
 * "en-GB" tries "en-GB" first, then "en", then returns the "en" value from the
 * map (which is the required baseline — template authors must always provide "en").
 * An unknown locale never throws and never returns an empty string as long as "en"
 * is present.
 */
export function resolveLocaleText(locale: string, map: LocalizedValues<string>): string {
  return resolveLocaleValue(locale, map);
}
