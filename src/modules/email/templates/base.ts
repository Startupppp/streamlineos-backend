import { appUrl } from "../app-url";
import {
  EMAIL_THEME,
  getBrandName,
  getEmailLogoUrl,
  getSupportEmail,
} from "../branding";

export { appUrl };

const { font: FONT } = EMAIL_THEME;

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EmailTemplateProps {
  title: string;
  preheader?: string;
  content: string;
}

function buildBrandMark(brandName: string): string {
  const logoUrl = getEmailLogoUrl();
  const safeName = escapeHtml(brandName);
  if (logoUrl) {
    return (
      `<td width="32" height="32" style="width:32px;height:32px;vertical-align:middle;">` +
      `<img src="${logoUrl}" alt="${safeName}" width="32" height="32" style="display:block;border:0;width:32px;height:32px;border-radius:8px;">` +
      `</td>`
    );
  }

  const initial = escapeHtml(brandName.charAt(0).toUpperCase() || "S");
  return (
    `<td width="32" height="32" bgcolor="${EMAIL_THEME.ink}" style="width:32px;height:32px;background-color:${EMAIL_THEME.ink};border-radius:8px;text-align:center;vertical-align:middle;">` +
    `<span style="font-family:${FONT};font-size:14px;font-weight:700;color:#ffffff;line-height:32px;display:inline-block;width:32px;text-align:center;">${initial}</span>` +
    `</td>`
  );
}

export function getEmailTemplate({
  title,
  preheader,
  content,
}: EmailTemplateProps): string {
  const supportEmail = getSupportEmail();
  const brandUrl = appUrl;
  const brandName = getBrandName();
  const safeBrandName = escapeHtml(brandName);
  const brandMark = buildBrandMark(brandName);
  const year = new Date().getFullYear();
  const preheaderText = preheader
    ? `<div style="display:none;font-size:1px;color:${EMAIL_THEME.canvas};line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${title}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    body {
      margin: 0 !important;
      padding: 0 !important;
      width: 100% !important;
      background-color: ${EMAIL_THEME.canvas};
      font-family: ${FONT};
      -webkit-font-smoothing: antialiased;
    }
    .email-label {
      font-family: ${FONT};
      font-size: 11px;
      font-weight: 700;
      color: ${EMAIL_THEME.accentDeep};
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin: 0 0 10px 0;
    }
    .email-title {
      font-family: ${FONT};
      font-size: 26px;
      font-weight: 700;
      color: ${EMAIL_THEME.ink};
      letter-spacing: -0.035em;
      line-height: 1.2;
      margin: 0 0 12px 0;
    }
    .email-text {
      font-family: ${FONT};
      font-size: 15px;
      line-height: 1.65;
      color: ${EMAIL_THEME.text};
      margin: 0 0 14px 0;
    }
    .credential-box {
      background-color: ${EMAIL_THEME.surface};
      border: 1px solid ${EMAIL_THEME.surfaceBorder};
      border-radius: 10px;
      padding: 4px 0;
      margin: 16px 0;
    }
    .credential-item {
      margin: 0;
      font-family: ${FONT};
      font-size: 13px;
      color: ${EMAIL_THEME.text};
    }
    .credential-label {
      font-weight: 600;
      color: ${EMAIL_THEME.ink};
    }
    .credential-value {
      color: ${EMAIL_THEME.accentDeep};
      font-weight: 600;
      background-color: #eff6ff;
      padding: 1px 7px;
      border-radius: 4px;
      display: inline-block;
      margin-left: 6px;
      font-size: 13px;
    }
    .divider {
      height: 1px;
      background-color: ${EMAIL_THEME.surfaceBorder};
      margin: 20px 0;
      border: none;
    }
    .fallback-url {
      font-family: Consolas, 'Courier New', Courier, monospace;
      font-size: 11px;
      color: ${EMAIL_THEME.textFaint};
      word-break: break-all;
      line-height: 1.5;
      display: block;
    }
    @media only screen and (max-width: 600px) {
      .email-shell { width: 100% !important; }
      .card-body { padding: 22px 20px 20px !important; }
      .brand-pad { padding: 18px 20px 16px !important; }
      .email-footer { padding: 14px 20px 18px !important; }
      .email-title { font-size: 22px !important; }
    }
    @media (prefers-color-scheme: dark) {
      body, .email-canvas { background-color: #070b14 !important; }
      .email-card { background-color: #111827 !important; border-color: #1f2937 !important; }
      .email-brand-row { background-color: #111827 !important; border-color: #1f2937 !important; }
      .email-brand-name { color: #f8fafc !important; }
      .email-title { color: #f8fafc !important; }
      .email-text { color: #cbd5e1 !important; }
      .email-label { color: #93c5fd !important; }
      .email-footer-bg { background-color: #0b1220 !important; border-color: #1f2937 !important; }
      .email-footer-text, .email-footer-text a { color: ${EMAIL_THEME.textFaint} !important; }
    }
  </style>
</head>
<body>
${preheaderText}
<table role="presentation" class="email-canvas" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:${EMAIL_THEME.canvas};">
  <tr>
    <td style="padding:40px 16px;" align="center">
      <table role="presentation" class="email-shell email-card" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;width:100%;background-color:${EMAIL_THEME.card};border-radius:14px;border:1px solid ${EMAIL_THEME.cardBorder};overflow:hidden;">
        <tr>
          <td style="padding:0;font-size:0;line-height:0;background-color:${EMAIL_THEME.accent};">
            <!--[if mso]>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560"><tr>
              <td bgcolor="${EMAIL_THEME.accent}" height="3" style="font-size:0;line-height:0;">&nbsp;</td>
            </tr></table>
            <![endif]-->
            <!--[if !mso]><!-->
            <div style="height:3px;line-height:3px;font-size:0;background-color:${EMAIL_THEME.accent};">&nbsp;</div>
            <!--<![endif]-->
          </td>
        </tr>
        <tr>
          <td class="brand-pad email-brand-row" style="background-color:${EMAIL_THEME.card};padding:22px 32px 18px;border-bottom:1px solid ${EMAIL_THEME.cardBorder};">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
              <tr>
                ${brandMark}
                <td style="vertical-align:middle;padding-left:11px;">
                  <span class="email-brand-name" style="font-family:${FONT};font-size:15px;font-weight:700;color:${EMAIL_THEME.ink};letter-spacing:-0.02em;">${safeBrandName}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="card-body" style="padding:28px 32px 28px;">
            ${content}
          </td>
        </tr>
        <tr>
          <td class="email-footer-bg" style="background-color:${EMAIL_THEME.footerBg};border-top:1px solid ${EMAIL_THEME.footerBorder};">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
              <tr>
                <td class="email-footer" style="padding:16px 32px 18px;text-align:center;">
                  <p class="email-footer-text" style="font-family:${FONT};font-size:12px;line-height:1.5;color:${EMAIL_THEME.textMuted};margin:0 0 6px 0;">
                    <strong style="color:${EMAIL_THEME.textStrong};">${safeBrandName}</strong>
                    &nbsp;&middot;&nbsp;
                    <a href="mailto:${supportEmail}" style="color:${EMAIL_THEME.textMuted};text-decoration:none;">${supportEmail}</a>
                  </p>
                  <p class="email-footer-text" style="font-family:${FONT};font-size:11px;line-height:1.5;color:${EMAIL_THEME.textFaint};margin:0;">
                    <a href="${brandUrl}/legal/privacy" style="color:${EMAIL_THEME.textFaint};text-decoration:underline;">Privacy</a>
                    &nbsp;&middot;&nbsp;
                    &copy; ${year} ${safeBrandName}
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
