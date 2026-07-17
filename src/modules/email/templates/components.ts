import { escapeHtml } from "./base";

export type Tone = "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, { accent: string; bg: string; text: string }> = {
  info:    { accent: "#3b82f6", bg: "#eff6ff",  text: "#1e40af" },
  success: { accent: "#16a34a", bg: "#f0fdf4",  text: "#15803d" },
  warning: { accent: "#d97706", bg: "#fffbeb",  text: "#92400e" },
  danger:  { accent: "#dc2626", bg: "#fef2f2",  text: "#991b1b" },
};

export function renderButton(label: string, url: string): string {
  const safeLabel = escapeHtml(label);
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:18px auto;">
  <tr>
    <td align="center" bgcolor="#0b1220" style="border-radius:8px;background:#0b1220;">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:42px;v-text-anchor:middle;width:200px;" arcsize="19%" stroke="f" fillcolor="#0b1220">
      <w:anchorlock/>
      <center style="color:#ffffff;font-family:'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;font-weight:600;">${safeLabel}</center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-->
      <a href="${url}" target="_blank" style="display:inline-block;padding:11px 24px;background:#0b1220;color:#ffffff;text-decoration:none;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;font-weight:600;border-radius:8px;letter-spacing:-0.01em;white-space:nowrap;">${safeLabel}</a>
      <!--<![endif]-->
    </td>
  </tr>
</table>`;
}

export function renderKeyValueRows(rows: Array<{ label: string; value: string }>): string {
  const items = rows
    .map(
      (row) =>
        `<p class="credential-item" style="margin:5px 0;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;color:#475569;"><span class="credential-label" style="font-weight:600;color:#0b1220;">${escapeHtml(row.label)}:</span><span class="credential-value" style="color:#1e40af;font-weight:500;background-color:#eff6ff;padding:1px 7px;border-radius:4px;display:inline-block;margin-left:6px;font-size:13px;">${escapeHtml(row.value)}</span></p>`,
    )
    .join("");
  return `<div class="credential-box" style="background-color:#f8fafc;border-left:3px solid #e2e8f0;padding:12px 14px;border-radius:0 6px 6px 0;margin:14px 0;">${items}</div>`;
}

export function renderCallout(text: string, tone: Tone = "info"): string {
  const t = TONES[tone];
  return `<div style="border-left:3px solid ${t.accent};padding:10px 14px;background:${t.bg};border-radius:0 6px 6px 0;margin:14px 0;"><p style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;line-height:1.6;color:${t.text};margin:0;">${text}</p></div>`;
}

export function renderBadge(label: string, tone: Tone): string {
  const t = TONES[tone];
  return `<span style="display:inline-block;font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:11px;font-weight:600;color:${t.text};background:${t.bg};border:1px solid ${t.accent};padding:2px 8px;border-radius:999px;letter-spacing:0.02em;">${escapeHtml(label)}</span>`;
}

export function renderFallbackLink(url: string): string {
  return `<p class="email-text" style="font-size:12px;color:#64748b;margin:0 0 6px 0;">If the button doesn&apos;t work, copy this link into your browser:</p><span class="fallback-url" style="font-family:'Courier New',Courier,monospace;font-size:11px;color:#94a3b8;word-break:break-all;line-height:1.5;display:block;">${escapeHtml(url)}</span>`;
}
