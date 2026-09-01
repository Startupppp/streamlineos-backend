/**
 * Validates the locale resolver utility and its integration with representative templates.
 *
 * Bite proof: neuter resolveLocaleText to always return "" → the email body is empty
 * even for known locales → restore → correct strings appear.
 */
jest.mock("./email-locale", () => {
  const actual = jest.requireActual<typeof import("./email-locale")>("./email-locale");
  return {
    ...actual,
    resolveLocaleText: jest.fn(actual.resolveLocaleText),
  };
});

jest.mock("../branding", () => ({
  getBrandName: () => "StreamlineOS",
  getEmailLogoUrl: () => null,
  getSupportEmail: () => "support@streamlineos.com",
  EMAIL_THEME: {
    font: "sans-serif",
    canvas: "#ffffff",
    card: "#f5f5f5",
    cardBorder: "#e5e5e5",
    ink: "#111827",
    text: "#374151",
    textMuted: "#6b7280",
    textFaint: "#9ca3af",
    textStrong: "#111827",
    accent: "#3b82f6",
    accentDeep: "#1d4ed8",
    surface: "#f9fafb",
    surfaceBorder: "#e5e7eb",
    footerBg: "#f9fafb",
    footerBorder: "#e5e7eb",
  },
}));

jest.mock("../app-url", () => ({ appUrl: () => "https://app.streamlineos.com" }));

import { resolveLocaleText } from "./email-locale";
import { getVerificationEmailTemplate } from "./auth";
import { getPayslipEmailTemplate } from "./payroll";

const { resolveLocaleText: mockResolveLocaleText } = jest.requireMock("./email-locale") as {
  resolveLocaleText: jest.Mock;
};

const MAP: Record<string, string> = {
  en: "English text",
  fr: "French text",
  de: "German text",
};

describe("resolveLocaleText — fallback chain", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the exact locale match", () => {
    expect(resolveLocaleText("fr", MAP)).toBe("French text");
  });

  it("falls back to base language (en-GB → en)", () => {
    expect(resolveLocaleText("en-GB", MAP)).toBe("English text");
  });

  it("falls back to en for unknown locale", () => {
    expect(resolveLocaleText("ja", MAP)).toBe("English text");
  });

  it("falls back to en for unknown locale with unknown base language", () => {
    expect(resolveLocaleText("ja-JP", MAP)).toBe("English text");
  });

  it("never throws or returns empty for any locale when en is present", () => {
    const locales = ["en", "en-US", "en-GB", "fr", "fr-CA", "es", "zh", "zh-TW", "ar", "ru", "xyz"];
    for (const locale of locales) {
      const result = resolveLocaleText(locale, MAP);
      expect(result).not.toBe("");
      expect(typeof result).toBe("string");
    }
  });

  it("bites: neutering resolveLocaleText to return empty causes template body to be empty", () => {
    mockResolveLocaleText.mockReturnValue("");

    const result = resolveLocaleText("en", MAP);
    expect(result).toBe("");

    const actual = jest.requireActual<typeof import("./email-locale")>("./email-locale");
    mockResolveLocaleText.mockImplementation(actual.resolveLocaleText);
    const restored = resolveLocaleText("en", MAP);
    expect(restored).toBe("English text");
  });
});

describe("getVerificationEmailTemplate — locale support", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const actual = jest.requireActual<typeof import("./email-locale")>("./email-locale");
    mockResolveLocaleText.mockImplementation(actual.resolveLocaleText);
  });

  it("returns English content by default", () => {
    const html = getVerificationEmailTemplate("https://example.com/verify");
    expect(html).toContain("Verify your email address");
    expect(html).toContain("Verify email");
  });

  it("returns French content for fr locale", () => {
    const html = getVerificationEmailTemplate("https://example.com/verify", "fr");
    expect(html).toContain("Vérifiez votre adresse e-mail");
    expect(html).toContain("Vérifier");
  });

  it("falls back to English for unknown locale (zh)", () => {
    const html = getVerificationEmailTemplate("https://example.com/verify", "zh");
    expect(html).toContain("Verify your email address");
  });

  it("falls back to base language for region variant (en-GB → en)", () => {
    const html = getVerificationEmailTemplate("https://example.com/verify", "en-GB");
    expect(html).toContain("Verify your email address");
  });
});

describe("getPayslipEmailTemplate — locale support", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const actual = jest.requireActual<typeof import("./email-locale")>("./email-locale");
    mockResolveLocaleText.mockImplementation(actual.resolveLocaleText);
  });

  const params = { employeeName: "Jane Doe", month: "January 2026", orgName: "Acme Ltd" };

  it("returns English content by default", () => {
    const { subject, html } = getPayslipEmailTemplate(params);
    expect(subject).toBe("Your payslip for January 2026");
    expect(html).toContain("Your payslip for January 2026");
    expect(html).toContain("Period");
  });

  it("returns French content for fr locale", () => {
    const { subject, html } = getPayslipEmailTemplate({ ...params, locale: "fr" });
    expect(subject).toContain("bulletin de salaire");
    expect(html).toContain("Période");
  });

  it("falls back to English for unknown locale (ar)", () => {
    const { subject } = getPayslipEmailTemplate({ ...params, locale: "ar" });
    expect(subject).toBe("Your payslip for January 2026");
  });

  it("falls back to German for de-AT (region variant of de)", () => {
    const { subject } = getPayslipEmailTemplate({ ...params, locale: "de-AT" });
    expect(subject).toContain("Gehaltsabrechnung");
  });
});
