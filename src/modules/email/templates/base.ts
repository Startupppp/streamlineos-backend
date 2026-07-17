import { appUrl } from "../app-url";
import { getBrandUrl, getSupportEmail, EMAIL_LOGO_URL } from "../email.constants";

export { appUrl };

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

function buildLogoLockup(): string {
  return (
    `<td width="32" height="32" style="width:32px;height:32px;vertical-align:middle;">` +
    `<img src="${EMAIL_LOGO_URL}" alt="StreamlineOS" width="32" height="32" style="display:block;border:0;width:32px;height:32px;border-radius:8px;">` +
    `</td>`
  );
}

export function getEmailTemplate({
  title,
  preheader,
  content,
}: EmailTemplateProps): string {
  const supportEmail = getSupportEmail();
  const brandUrl = getBrandUrl();
  const logoCell = buildLogoLockup();
  const preheaderText = preheader
    ? `<div style="display:none;font-size:1px;color:#f1f5f9;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${title}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap');

    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }

    body {
      margin: 0;
      padding: 0;
      background-color: #f1f5f9;
      font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    .email-title {
      font-family: 'Geist', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 18px;
      font-weight: 700;
      color: #0b1220;
      letter-spacing: -0.02em;
      line-height: 1.25;
      margin: 0 0 12px 0;
    }

    .email-text {
      font-family: 'Geist', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #475569;
      margin: 0 0 12px 0;
    }

    .email-label {
      font-family: 'Geist', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin: 0 0 6px 0;
    }

    .credential-box {
      background-color: #f8fafc;
      border-left: 3px solid #e2e8f0;
      padding: 12px 14px;
      border-radius: 0 6px 6px 0;
      margin: 14px 0;
    }

    .credential-item {
      margin: 5px 0;
      font-family: 'Geist', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 13px;
      color: #475569;
    }

    .credential-label {
      font-weight: 600;
      color: #0b1220;
    }

    .credential-value {
      color: #1e40af;
      font-family: 'Geist', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      font-weight: 500;
      background-color: #eff6ff;
      padding: 1px 7px;
      border-radius: 4px;
      display: inline-block;
      margin-left: 6px;
      font-size: 13px;
    }

    .divider {
      height: 1px;
      background-color: #e2e8f0;
      margin: 18px 0;
      border: none;
    }

    .fallback-url {
      font-family: 'Courier New', Courier, monospace;
      font-size: 12px;
      color: #64748b;
      word-break: break-all;
      line-height: 1.5;
      display: block;
    }

    @media only screen and (max-width: 600px) {
      .card-body { padding: 20px 16px 16px !important; }
      .email-footer { padding: 12px 16px 16px !important; }
      .email-title { font-size: 16px !important; }
      .sm-full { width: 100% !important; }
    }
  </style>
</head>
<body>
${preheaderText}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f1f5f9;">
  <tr>
    <td style="padding:24px 16px;" align="center">

      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" class="sm-full" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;">

        <!-- Top accent stripe -->
        <tr>
          <td style="padding:0;font-size:0;line-height:0;">
            <!--[if mso]>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560"><tr>
            <td bgcolor="#1e40af" height="3" style="font-size:0;line-height:0;">&nbsp;</td>
            </tr></table>
            <![endif]-->
            <!--[if !mso]><!-->
            <div style="height:3px;background:linear-gradient(90deg,#1e40af 0%,#3b82f6 60%,#60a5fa 100%);font-size:0;line-height:0;">&nbsp;</div>
            <!--<![endif]-->
          </td>
        </tr>

        <!-- Card body -->
        <tr>
          <td style="padding:24px 28px 20px;" class="card-body">

            <!-- Brand header -->
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px 0;">
              <tr>
                ${logoCell}
                <td style="vertical-align:middle;padding-left:9px;">
                  <span style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;font-weight:600;color:#0b1220;letter-spacing:-0.01em;">Streamline<span style="color:#1e40af;">OS</span></span>
                </td>
              </tr>
            </table>

            <!-- Divider under brand -->
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 20px 0;">
              <tr><td height="1" bgcolor="#f1f5f9" style="font-size:0;line-height:0;">&nbsp;</td></tr>
            </table>

            ${content}

          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
              <tr><td height="1" bgcolor="#e2e8f0" style="font-size:0;line-height:0;">&nbsp;</td></tr>
              <tr>
                <td style="padding:14px 28px 16px;text-align:center;" class="email-footer">
                  <p style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;color:#94a3b8;margin:0 0 3px 0;">Sent by <strong style="color:#64748b;">StreamlineOS</strong> &nbsp;&middot;&nbsp; <a href="mailto:${supportEmail}" style="color:#94a3b8;text-decoration:underline;">${supportEmail}</a></p>
                  <p style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:11px;color:#94a3b8;margin:0 0 3px 0;">You&apos;re receiving this because you have a StreamlineOS account.</p>
                  <p style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:11px;color:#cbd5e1;margin:0;"><a href="${brandUrl}/legal/privacy" style="color:#cbd5e1;text-decoration:underline;">Privacy Policy</a></p>
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
