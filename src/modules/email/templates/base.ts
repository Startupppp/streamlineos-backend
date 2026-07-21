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
      `<img src="${escapeHtml(logoUrl)}" alt="${safeName}" width="36" height="36" style="display:block;border:0;outline:none;text-decoration:none;width:36px;height:36px;border-radius:9px;">` +
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
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
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
    html, body { width: 100% !important; margin: 0 !important; padding: 0 !important; }
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; max-width: 100%; }
    body {
      width: 100% !important;
      background-color: ${EMAIL_THEME.canvas};
      font-family: ${FONT};
      -webkit-font-smoothing: antialiased;
    }
    .email-shell {
      width: 100% !important;
      max-width: 600px !important;
    }
    .email-btn-wrap-primary {
      width: 100% !important;
      max-width: 100% !important;
    }
    .email-btn-table {
      width: auto !important;
      max-width: 100% !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }
    .email-btn-link-primary {
      display: inline-block !important;
      box-sizing: border-box !important;
      text-align: center !important;
      min-height: 48px !important;
    }
    .email-btn-link-secondary {
      display: inline-block !important;
      text-align: left !important;
      min-height: 44px !important;
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
      word-break: break-word;
    }
    .email-text {
      font-family: ${FONT};
      font-size: 15px;
      line-height: 1.65;
      color: ${EMAIL_THEME.text};
      margin: 0 0 14px 0;
      word-break: break-word;
    }
    .credential-box {
      background-color: ${EMAIL_THEME.surface};
      border: 1px solid ${EMAIL_THEME.surfaceBorder};
      border-radius: 10px;
      padding: 4px 0;
      margin: 16px 0;
      width: 100%;
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
    @media only screen and (max-width: 620px) {
      .email-outer-pad { padding: 12px 8px !important; }
      .email-shell {
        width: 100% !important;
        max-width: 100% !important;
      }
      .card-body { padding: 20px 16px 18px !important; }
      .brand-pad { padding: 16px 16px 12px !important; }
      .email-footer { padding: 14px 16px 16px !important; }
      .email-title { font-size: 22px !important; }
      .email-btn-wrap-primary,
      .email-btn-wrap-primary td,
      .email-btn-table,
      .email-btn-table td,
      .email-btn-primary {
        display: block !important;
        width: 100% !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
      }
      .email-btn-link-primary {
        display: block !important;
        width: 100% !important;
        max-width: 100% !important;
        padding: 14px 18px !important;
        min-height: 48px !important;
        font-size: 15px !important;
        text-align: center !important;
      }
      .email-btn-wrap-secondary,
      .email-btn-wrap-secondary td {
        width: 100% !important;
      }
      .email-btn-link-secondary {
        display: block !important;
        width: 100% !important;
        box-sizing: border-box !important;
        text-align: center !important;
        padding: 12px 8px !important;
      }
      .email-otp-digits {
        font-size: 26px !important;
        letter-spacing: 0.18em !important;
        padding-left: 0.18em !important;
      }
      .kv-label,
      .kv-value {
        display: block !important;
        width: 100% !important;
        box-sizing: border-box !important;
      }
      .kv-label {
        padding-bottom: 2px !important;
        border-bottom: 0 !important;
      }
      .kv-value {
        padding-top: 0 !important;
      }
      .email-stack-col {
        display: block !important;
        width: 100% !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
        padding-left: 0 !important;
        padding-right: 0 !important;
      }
      .email-rating-btn {
        display: block !important;
        width: 100% !important;
        box-sizing: border-box !important;
        padding: 4px 0 !important;
      }
      .email-rating-btn a {
        display: block !important;
        width: 100% !important;
        box-sizing: border-box !important;
        text-align: center !important;
        padding: 12px 16px !important;
        min-height: 44px !important;
      }
    }
    @media (prefers-color-scheme: dark) {
      body, .email-canvas { background-color: #070b14 !important; }
      .email-card { background-color: #111827 !important; border-color: #1f2937 !important; }
      .email-brand-row { background-color: #0b1220 !important; }
      .email-brand-name { color: #f8fafc !important; }
      .email-title { color: #f8fafc !important; }
      .email-text { color: #cbd5e1 !important; }
      .email-label { color: #93c5fd !important; }
      .email-footer-bg { background-color: #0b1220 !important; border-color: #1f2937 !important; }
      .email-footer-text, .email-footer-text a { color: ${EMAIL_THEME.textFaint} !important; }
      .email-btn-link-secondary { color: #93c5fd !important; }
    }
  </style>
</head>
<body width="100%" style="margin:0;padding:0;width:100%;background-color:${EMAIL_THEME.canvas};">
${preheaderText}
<table role="presentation" class="email-canvas" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100%;background-color:${EMAIL_THEME.canvas};border-collapse:collapse;">
  <tr>
    <td class="email-outer-pad" align="center" style="padding:28px 12px;width:100%;">
      <!--[if mso]>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" align="center"><tr><td>
      <![endif]-->
      <table role="presentation" class="email-shell email-card" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100%;max-width:600px;background-color:${EMAIL_THEME.card};border-radius:14px;border:1px solid ${EMAIL_THEME.cardBorder};overflow:hidden;border-collapse:separate;">
        <tr>
          <td style="padding:0;font-size:0;line-height:0;background-color:${EMAIL_THEME.accent};">
            <!--[if mso]>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600"><tr>
              <td bgcolor="${EMAIL_THEME.accent}" height="3" style="font-size:0;line-height:0;">&nbsp;</td>
            </tr></table>
            <![endif]-->
            <!--[if !mso]><!-->
            <div style="height:3px;line-height:3px;font-size:0;background-color:${EMAIL_THEME.accent};">&nbsp;</div>
            <!--<![endif]-->
          </td>
        </tr>
        <tr>
          <td class="brand-pad email-brand-row" bgcolor="${EMAIL_THEME.ink}" style="background-color:${EMAIL_THEME.ink};padding:20px 28px;border-bottom:0;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100%;">
              <tr>
                ${brandMark}
                <td style="vertical-align:middle;padding-left:12px;width:100%;">
                  <span class="email-brand-name" style="font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">${safeBrandName}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="card-body" style="padding:28px 28px 26px;">
            ${content}
          </td>
        </tr>
        <tr>
          <td class="email-footer-bg" style="background-color:${EMAIL_THEME.footerBg};border-top:1px solid ${EMAIL_THEME.footerBorder};">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100%;">
              <tr>
                <td class="email-footer" style="padding:16px 28px 18px;text-align:center;">
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
      <!--[if mso]>
      </td></tr></table>
      <![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;
}
