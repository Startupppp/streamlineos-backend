import { EMAIL_THEME } from "../branding";
import { escapeHtml } from "./base";

export type Tone = "info" | "success" | "warning" | "danger";
export type ButtonVariant = "primary" | "secondary";

const TONES: Record<Tone, { accent: string; bg: string; text: string; border: string }> = {
  info: { accent: EMAIL_THEME.accent, bg: "#eff6ff", text: "#1e3a8a", border: "#bfdbfe" },
  success: { accent: "#16a34a", bg: "#f0fdf4", text: "#166534", border: "#bbf7d0" },
  warning: { accent: "#d97706", bg: "#fffbeb", text: "#92400e", border: "#fde68a" },
  danger: { accent: "#dc2626", bg: "#fef2f2", text: "#991b1b", border: "#fecaca" },
};

const FONT = EMAIL_THEME.font;

export function renderButton(
  label: string,
  url: string,
  variant: ButtonVariant = "primary",
): string {
  const safeLabel = escapeHtml(label);
  const isPrimary = variant === "primary";

  if (!isPrimary) {
    return `<table role="presentation" class="email-btn-wrap email-btn-wrap-secondary" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:8px 0 4px 0;width:100%;">
  <tr>
    <td align="left" style="padding:0;">
      <a href="${url}" target="_blank" class="email-btn-link-secondary" style="display:inline-block;padding:12px 2px;min-height:44px;line-height:20px;color:${EMAIL_THEME.accentDeep};text-decoration:underline;font-family:${FONT};font-size:14px;font-weight:600;letter-spacing:-0.01em;text-align:left;">${safeLabel}</a>
    </td>
  </tr>
</table>`;
  }

  const bg = EMAIL_THEME.ink;
  const fg = "#ffffff";
  const border = EMAIL_THEME.ink;

  return `<table role="presentation" class="email-btn-wrap email-btn-wrap-primary" cellspacing="0" cellpadding="0" border="0" style="margin:22px 0 10px 0;">
  <tr>
    <td align="left" style="padding:0;">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="21%" strokecolor="${border}" strokeweight="1px" fillcolor="${bg}">
      <w:anchorlock/>
      <center style="color:${fg};font-family:Segoe UI,Roboto,Arial,sans-serif;font-size:15px;font-weight:600;">${safeLabel}</center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-->
      <table role="presentation" class="email-btn-table" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;">
        <tr>
          <td align="center" bgcolor="${bg}" class="email-btn-primary" style="border-radius:10px;background-color:${bg};border:1px solid ${border};">
            <a href="${url}" target="_blank" class="email-btn-link-primary" style="display:inline-block;box-sizing:border-box;padding:14px 28px;min-height:48px;line-height:20px;background-color:${bg};color:${fg};text-decoration:none;font-family:${FONT};font-size:15px;font-weight:600;border-radius:10px;letter-spacing:-0.01em;text-align:center;border:0;mso-padding-alt:0;">${safeLabel}</a>
          </td>
        </tr>
      </table>
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
          ? `border-bottom:1px solid ${EMAIL_THEME.canvas};`
          : "";
      return `<tr>
  <td class="kv-label" style="padding:11px 14px;${border}font-family:${FONT};font-size:12px;font-weight:600;color:${EMAIL_THEME.textMuted};letter-spacing:0.02em;width:36%;vertical-align:top;">${escapeHtml(row.label)}</td>
  <td class="kv-value" style="padding:11px 14px;${border}font-family:${FONT};font-size:13px;font-weight:600;color:${EMAIL_THEME.ink};vertical-align:top;word-break:break-word;">${escapeHtml(row.value)}</td>
</tr>`;
    })
    .join("");

  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:18px 0;width:100%;background-color:${EMAIL_THEME.surface};border:1px solid ${EMAIL_THEME.surfaceBorder};border-radius:12px;overflow:hidden;">
  ${items}
</table>`;
}

export function renderCallout(text: string, tone: Tone = "info"): string {
  const t = TONES[tone];
  return `<table role="presentation" class="email-callout" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0 4px 0;width:100%;background-color:${t.bg};border:1px solid ${t.border};border-radius:10px;overflow:hidden;">
  <tr>
    <td width="4" bgcolor="${t.accent}" style="width:4px;max-width:4px;background-color:${t.accent};font-size:0;line-height:0;">&nbsp;</td>
    <td style="padding:13px 14px;">
      <p style="font-family:${FONT};font-size:13px;line-height:1.55;color:${t.text};margin:0;word-break:break-word;">${text}</p>
    </td>
  </tr>
</table>`;
}

export function renderBadge(label: string, tone: Tone): string {
  const t = TONES[tone];
  return `<span style="display:inline-block;font-family:${FONT};font-size:11px;font-weight:700;color:${t.text};background-color:${t.bg};border:1px solid ${t.border};padding:3px 9px;border-radius:999px;letter-spacing:0.02em;line-height:1.2;">${escapeHtml(label)}</span>`;
}

export function renderFallbackLink(url: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:22px 0 0 0;width:100%;">
  <tr>
    <td align="left" style="padding:0;">
      <p style="font-family:${FONT};font-size:12px;line-height:1.5;color:${EMAIL_THEME.textMuted};margin:0 0 6px 0;">Or paste this link into your browser:</p>
      <p class="fallback-url" style="font-family:Consolas,'Courier New',Courier,monospace;font-size:11px;line-height:1.55;color:${EMAIL_THEME.textFaint};word-break:break-all;margin:0;padding:10px 12px;background-color:${EMAIL_THEME.surface};border:1px solid ${EMAIL_THEME.surfaceBorder};border-radius:8px;">${escapeHtml(url)}</p>
    </td>
  </tr>
</table>`;
}

export function renderOtpCode(code: string): string {
  const digits = escapeHtml(code);
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:24px 0;width:100%;">
  <tr>
    <td align="center" style="padding:0;background-color:${EMAIL_THEME.surface};border:1px solid ${EMAIL_THEME.surfaceBorder};border-radius:14px;overflow:hidden;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100%;">
        <tr>
          <td width="4" bgcolor="${EMAIL_THEME.accent}" style="width:4px;max-width:4px;background-color:${EMAIL_THEME.accent};font-size:0;line-height:0;">&nbsp;</td>
          <td align="center" style="padding:22px 14px;">
            <p style="font-family:${FONT};font-size:11px;font-weight:700;color:${EMAIL_THEME.textMuted};letter-spacing:0.14em;text-transform:uppercase;margin:0 0 14px 0;">One-time code</p>
            <p class="email-otp-digits" style="font-family:Consolas,'Courier New',Courier,monospace;font-size:32px;font-weight:700;letter-spacing:0.28em;color:${EMAIL_THEME.ink};margin:0;line-height:1.2;padding-left:0.28em;word-break:break-all;">${digits}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}
