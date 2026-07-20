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
      `<td width="36" height="36" style="width:36px;height:36px;vertical-align:middle;">` +
      `<img src="${logoUrl}" alt="${safeName}" width="36" height="36" style="display:block;border:0;width:36px;height:36px;border-radius:9px;">` +
      `</td>`
    );
  }

  const initial = escapeHtml(brandName.charAt(0).toUpperCase() || "S");
  return (
    `<td width="36" height="36" bgcolor="${EMAIL_THEME.accent}" style="width:36px;height:36px;background-color:${EMAIL_THEME.accent};border-radius:9px;text-align:center;vertical-align:middle;">` +
    `<span style="font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;line-height:36px;display:inline-block;width:36px;text-align:center;">${initial}</span>` +
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
    .email-title {
      font-family: ${FONT};
      font-size: 22px;
      font-weight: 700;
      color: ${EMAIL_THEME.ink};
      letter-spacing: -0.03em;
      line-height: 1.25;
      margin: 0 0 10px 0;
    }
    .email-text {
      font-family: ${FONT};
      font-size: 15px;
      line-height: 1.6;
      color: ${EMAIL_THEME.text};
      margin: 0 0 12px 0;
    }
    .email-label {
      font-family: ${FONT};
      font-size: 11px;
      font-weight: 700;
      color: ${EMAIL_THEME.textFaint};
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin: 0 0 6px 0;
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
      .card-body { padding: 26px 18px 22px !important; }
      .email-footer { padding: 16px 18px 18px !important; }
      .email-title { font-size: 20px !important; }
      .brand-pad { padding: 18px 18px !important; }
    }
    @media (prefers-color-scheme: dark) {
      body, .email-canvas { background-color: #070b14 !important; }
      .email-card { background-color: #111827 !important; border-color: #1f2937 !important; }
      .email-title { color: #f8fafc !important; }
      .email-text { color: #cbd5e1 !important; }
      .email-footer-bg { background-color: ${EMAIL_THEME.ink} !important; border-color: #1f2937 !important; }
      .email-footer-text, .email-footer-text a { color: ${EMAIL_THEME.textFaint} !important; }
    }
  </style>
</head>
<body>
${preheaderText}
<table role="presentation" class="email-canvas" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:${EMAIL_THEME.canvas};">
  <tr>
    <td style="padding:36px 16px;" align="center">
      <table role="presentation" class="email-shell email-card" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;width:100%;background-color:${EMAIL_THEME.card};border-radius:16px;border:1px solid ${EMAIL_THEME.cardBorder};overflow:hidden;">
        <tr>
          <td class="brand-pad" bgcolor="${EMAIL_THEME.ink}" style="background-color:${EMAIL_THEME.ink};padding:22px 28px;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
              <tr>
                ${brandMark}
                <td style="vertical-align:middle;padding-left:12px;">
                  <span style="font-family:${FONT};font-size:17px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">${safeBrandName}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
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
          <td class="card-body" style="padding:28px 28px 26px;">
            ${content}
          </td>
        </tr>
        <tr>
          <td class="email-footer-bg" style="background-color:${EMAIL_THEME.footerBg};border-top:1px solid ${EMAIL_THEME.footerBorder};">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
              <tr>
                <td class="email-footer" style="padding:18px 28px 20px;text-align:center;">
                  <p class="email-footer-text" style="font-family:${FONT};font-size:12px;line-height:1.5;color:${EMAIL_THEME.textMuted};margin:0 0 4px 0;">
                    Sent by <strong style="color:${EMAIL_THEME.textStrong};">${safeBrandName}</strong>
                    &nbsp;&middot;&nbsp;
                    <a href="mailto:${supportEmail}" style="color:${EMAIL_THEME.textMuted};text-decoration:underline;">${supportEmail}</a>
                  </p>
                  <p class="email-footer-text" style="font-family:${FONT};font-size:11px;line-height:1.5;color:${EMAIL_THEME.textFaint};margin:0 0 4px 0;">
                    You&apos;re receiving this because you have a ${safeBrandName} account or interaction.
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
