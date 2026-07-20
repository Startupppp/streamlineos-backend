const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_BRAND_NAME = "StreamlineOS";
const DEFAULT_SUPPORT_EMAIL = "support@streamlineos.in";

export const EMAIL_THEME = {
  ink: "#0b1220",
  accent: "#3b82f6",
  accentDeep: "#1e40af",
  canvas: "#e8edf5",
  card: "#ffffff",
  cardBorder: "#dbe3ef",
  footerBg: "#f8fafc",
  footerBorder: "#e2e8f0",
  text: "#475569",
  textMuted: "#64748b",
  textFaint: "#94a3b8",
  textStrong: "#334155",
  surface: "#f8fafc",
  surfaceBorder: "#e2e8f0",
  font: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
} as const;

export function getBrandName(): string {
  return (
    process.env.APP_BRAND_NAME?.trim() ||
    process.env.EMAIL_FROM_NAME?.trim() ||
    DEFAULT_BRAND_NAME
  );
}

export function getSupportEmail(): string {
  const candidates = [
    process.env.BRAND_SUPPORT_EMAIL?.trim(),
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim(),
  ];
  for (const candidate of candidates) {
    if (candidate && EMAIL_RE.test(candidate)) {
      return candidate;
    }
  }
  return DEFAULT_SUPPORT_EMAIL;
}

export function getEmailLogoUrl(): string | null {
  const base = (process.env.NEXT_PUBLIC_R2_PUBLIC_URL ?? "").trim().replace(/\/$/, "");
  if (!base) return null;
  return `${base}/email-assets/logo-v2.png`;
}
