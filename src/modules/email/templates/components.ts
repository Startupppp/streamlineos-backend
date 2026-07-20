import { escapeHtml } from "./base";

export type Tone = "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, { accent: string; bg: string; text: string; border: string }> = {
  info: { accent: "#3b82f6", bg: "#eff6ff", text: "#1e3a8a", border: "#bfdbfe" },
  success: { accent: "#16a34a", bg: "#f0fdf4", text: "#166534", border: "#bbf7d0" },
  warning: { accent: "#d97706", bg: "#fffbeb", text: "#92400e", border: "#fde68a" },
  danger: { accent: "#dc2626", bg: "#fef2f2", text: "#991b1b", border: "#fecaca" },
};

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function renderButton(label: string, url: string): string {
  const safeLabel = escapeHtml(label);
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:22px 0 8px 0;">
  <tr>
    <td align="left" bgcolor="#0b1220" style="border-radius:8px;background-color:#0b1220;">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="18%" stroke="f" fillcolor="#0b1220">
      <w:anchorlock/>
      <center style="color:#ffffff;font-family:Segoe UI,Roboto,Arial,sans-serif;font-size:14px;font-weight:600;">${safeLabel}</center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-->
      <a href="${url}" target="_blank" style="display:inline-block;padding:12px 26px;background-color:#0b1220;color:#ffffff;text-decoration:none;font-family:${FONT};font-size:14px;font-weight:600;border-radius:8px;letter-spacing:-0.01em;line-height:1.2;border:1px solid #0b1220;">${safeLabel}</a>
      <!--<![endif]-->
    </td>
  </tr>
</table>`;
}

export function renderKeyValueRows(rows: Array<{ label: string; value: string }>): string {
  const items = rows
    .map((row, index) => {
      const border =
        index < rows.length - 1
          ? "border-bottom:1px solid #e8edf5;"
          : "";
      return `<tr>
  <td style="padding:10px 14px;${border}font-family:${FONT};font-size:12px;font-weight:600;color:#64748b;letter-spacing:0.02em;width:36%;vertical-align:top;">${escapeHtml(row.label)}</td>
  <td style="padding:10px 14px;${border}font-family:${FONT};font-size:13px;font-weight:600;color:#0b1220;vertical-align:top;">${escapeHtml(row.value)}</td>
</tr>`;
    })
    .join("");

  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:16px 0;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
  ${items}
</table>`;
}

export function renderCallout(text: string, tone: Tone = "info"): string {
  const t = TONES[tone];
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:16px 0;">
  <tr>
    <td style="padding:12px 14px;background-color:${t.bg};border:1px solid ${t.border};border-left:3px solid ${t.accent};border-radius:0 8px 8px 0;">
      <p style="font-family:${FONT};font-size:13px;line-height:1.55;color:${t.text};margin:0;">${text}</p>
    </td>
  </tr>
</table>`;
}

export function renderBadge(label: string, tone: Tone): string {
  const t = TONES[tone];
  return `<span style="display:inline-block;font-family:${FONT};font-size:11px;font-weight:700;color:${t.text};background-color:${t.bg};border:1px solid ${t.border};padding:3px 9px;border-radius:999px;letter-spacing:0.02em;line-height:1.2;">${escapeHtml(label)}</span>`;
}

export function renderFallbackLink(url: string): string {
  return `<p style="font-family:${FONT};font-size:12px;line-height:1.5;color:#64748b;margin:18px 0 6px 0;">If the button doesn&apos;t work, copy and paste this link into your browser:</p>
<p style="font-family:Consolas,'Courier New',Courier,monospace;font-size:11px;line-height:1.55;color:#94a3b8;word-break:break-all;margin:0;">${escapeHtml(url)}</p>`;
}

export function renderOtpCode(code: string): string {
  const digits = escapeHtml(code);
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:22px 0;">
  <tr>
    <td align="center" style="padding:22px 16px;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
      <p style="font-family:${FONT};font-size:11px;font-weight:700;color:#64748b;letter-spacing:0.12em;text-transform:uppercase;margin:0 0 12px 0;">One-time code</p>
      <p style="font-family:Consolas,'Courier New',Courier,monospace;font-size:34px;font-weight:700;letter-spacing:0.32em;color:#0b1220;margin:0;line-height:1.2;padding-left:0.32em;">${digits}</p>
    </td>
  </tr>
</table>`;
}
