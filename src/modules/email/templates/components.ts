import { escapeHtml } from "./base";

export type Tone = "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, { accent: string; bg: string; text: string }> = {
  info: { accent: "#06b6d4", bg: "rgba(6,182,212,0.05)", text: "#155e75" },
  success: { accent: "#16a34a", bg: "#f0fdf4", text: "#166534" },
  warning: { accent: "#d97706", bg: "#fffbeb", text: "#92400e" },
  danger: { accent: "#dc2626", bg: "#fef2f2", text: "#991b1b" },
};

export function renderButton(label: string, url: string): string {
  return `<a href="${url}" class="email-button" target="_blank" style="display:block;width:100%;background:linear-gradient(135deg,#1e40af 0%,#3b82f6 100%);color:#ffffff;text-decoration:none;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;font-weight:600;letter-spacing:0.02em;padding:13px 28px;border-radius:8px;text-align:center;border:2px solid #1e40af;margin:20px 0;box-sizing:border-box;">${escapeHtml(label)}</a>`;
}

export function renderKeyValueRows(rows: Array<{ label: string; value: string }>): string {
  const items = rows
    .map(
      (row) =>
        `<p class="credential-item" style="margin:6px 0;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;color:#4A5568;"><span class="credential-label" style="font-weight:600;color:#0b1220;">${escapeHtml(row.label)}:</span><span class="credential-value" style="color:#1e40af;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-weight:600;background-color:#EEF3FF;padding:2px 9px;border-radius:6px;display:inline-block;margin-left:8px;font-size:13px;">${escapeHtml(row.value)}</span></p>`,
    )
    .join("");
  return `<div class="credential-box" style="background-color:#F7F9FF;border-left:4px solid #3b82f6;padding:13px 16px;border-radius:0 8px 8px 0;margin:16px 0;">${items}</div>`;
}

export function renderCallout(text: string, tone: Tone = "info"): string {
  const t = TONES[tone];
  return `<div style="border-left:4px solid ${t.accent};padding:11px 14px;background:${t.bg};border-radius:0 6px 6px 0;margin:16px 0;"><p style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:13.5px;line-height:1.55;color:${t.text};margin:0;">${text}</p></div>`;
}

export function renderBadge(label: string, tone: Tone): string {
  const t = TONES[tone];
  return `<span style="display:inline-block;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;font-weight:600;color:${t.text};background:${t.bg};border:1px solid ${t.accent};padding:3px 10px;border-radius:999px;letter-spacing:0.02em;">${escapeHtml(label)}</span>`;
}

export function renderFallbackLink(url: string): string {
  return `<p class="email-text" style="font-size:13px;margin:0 0 8px 0;">If the button doesn't work, copy this link into your browser:</p><span class="fallback-url" style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#64748B;word-break:break-all;line-height:1.5;display:block;">${escapeHtml(url)}</span>`;
}
