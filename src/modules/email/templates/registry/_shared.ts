import { appUrl } from "../../app-url";
import { getBrandName } from "../../branding";
import { resolveAvailableLocale } from "../../../../common/i18n/locale-fallback";
import { EMAIL_TEMPLATE_VERSION } from "../email-locale";

export { EMAIL_TEMPLATE_VERSION };

export { appUrl as BASE_URL };
export const BRAND = getBrandName();

interface TemplateDraft {
  category: string;
  name: string;
  subject: string | ((locale: string) => string);
  generateHtml: (locale?: string) => string;
  supportedLocales?: readonly string[];
}

export interface RenderedTemplateEntry {
  subject: string;
  html: string;
  locale: string;
  version: number;
}

export interface TemplateEntry {
  category: string;
  name: string;
  subject: string;
  version: number;
  supportedLocales: readonly string[];
  generateHtml: (locale?: string) => string;
  render: (locale?: string) => RenderedTemplateEntry;
}

export function defineTemplateFamily(
  drafts: Record<string, TemplateDraft>,
  version: number,
): Record<string, TemplateEntry> {
  const entries: Record<string, TemplateEntry> = {};
  for (const [templateId, draft] of Object.entries(drafts)) {
    const supportedLocales = draft.supportedLocales ?? ["en"];
    const render = (requestedLocale = "en"): RenderedTemplateEntry => {
      const locale =
        resolveAvailableLocale(requestedLocale, supportedLocales) ?? "en";
      return {
        subject:
          typeof draft.subject === "function"
            ? draft.subject(locale)
            : draft.subject,
        html: draft.generateHtml(locale),
        locale,
        version,
      };
    };
    entries[templateId] = {
      category: draft.category,
      name: draft.name,
      subject: render().subject,
      version,
      supportedLocales,
      generateHtml: (locale) => render(locale).html,
      render,
    };
  }
  return entries;
}
