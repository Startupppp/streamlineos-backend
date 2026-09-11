import { appUrl } from "../app-url";
import { EMAIL_THEME, getBrandName, getEmailLogoUrl, getSupportEmail } from "../branding";
import { buildEmailStyles } from "./email-template-styles";

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
  const safeName = escapeHtml(brandName);
  const logoUrl = getEmailLogoUrl();
  if (!logoUrl) {
    const initial = escapeHtml(brandName.charAt(0).toUpperCase() || "S");
    return (
      `<td width="40" height="40" bgcolor="${EMAIL_THEME.card}" style="width:40px;height:40px;background-color:${EMAIL_THEME.card};border-radius:10px;text-align:center;vertical-align:middle;">` +
      `<span style="font-family:${FONT};font-size:18px;font-weight:700;color:${EMAIL_THEME.ink};line-height:40px;display:inline-block;width:40px;text-align:center;">${initial}</span>` +
      `</td>`
    );
  }
  return (
    `<td width="40" style="width:40px;vertical-align:middle;">` +
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="40" style="width:40px;border-collapse:collapse;">` +
    `<tr>` +
    `<td width="40" height="40" bgcolor="${EMAIL_THEME.card}" style="width:40px;height:40px;background-color:${EMAIL_THEME.card};border-radius:10px;text-align:center;vertical-align:middle;">` +
    `<img src="${escapeHtml(logoUrl)}" alt="${safeName}" width="30" height="30" style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none;width:30px;height:30px;max-width:30px;border-radius:7px;">` +
    `</td>` +
    `</tr>` +
    `</table>` +
    `</td>`
  );
}

export function getEmailTemplate({
  title,
  preheader,
  content,
}: EmailTemplateProps): string {
  const supportEmail = getSupportEmail();
  const brandUrl = appUrl();
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
${buildEmailStyles()}
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
