import { appUrl } from "../app-url";
import { getBrandUrl, getSupportEmail } from "../email.constants";

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
  const r2Base = process.env.NEXT_PUBLIC_R2_PUBLIC_URL?.trim().replace(/\/$/, "");
  const logoSrc = r2Base ? `${r2Base}/email-assets/logo-v2.png` : null;

  if (logoSrc) {
    return (
      `<td width="40" height="40" style="width:40px;height:40px;vertical-align:middle;">` +
      `<img src="${logoSrc}" alt="StreamlineOS" width="40" height="40" style="display:block;border:0;width:40px;height:40px;border-radius:9px;">` +
      `</td>`
    );
  }

  return (
    `<td width="36" height="36" align="center" valign="middle" bgcolor="#0b1220" style="width:36px;height:36px;border-radius:9px;background:#0b1220;font-size:0;line-height:0;">` +
    `<span style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:17px;font-weight:700;color:#ffffff;line-height:36px;display:inline-block;letter-spacing:-0.02em;">S</span>` +
    `</td>`
  );
}

export function getEmailTemplate({ title, preheader, content }: EmailTemplateProps): string {
  const supportEmail = getSupportEmail();
  const brandUrl = getBrandUrl();
  const logoCell = buildLogoLockup();
  const preheaderText = preheader
    ? `<div style="display:none;font-size:1px;color:#EEF3FB;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>${title}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap');

    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }

    body {
      margin: 0;
      padding: 0;
      background-color: #EEF3FB;
      font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .email-title {
      font-family: 'Geist', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 24px;
      font-weight: 700;
      color: #0b1220;
      letter-spacing: -0.02em;
      line-height: 1.2;
      margin: 0 0 10px 0;
    }

    .email-text {
      font-family: 'Geist', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 15px;
      line-height: 1.6;
      color: #4A5568;
      margin: 0 0 14px 0;
    }

    .email-label {
      font-family: 'Geist', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 11px;
      font-weight: 600;
      color: #94A3B8;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin: 0 0 8px 0;
    }

    .email-button {
      display: block;
      width: 100%;
      background: linear-gradient(135deg, #1e40af 0%, #3b82f6 100%);
      color: #ffffff !important;
      text-decoration: none;
      font-family: 'Geist', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.02em;
      padding: 13px 28px;
      border-radius: 8px;
      text-align: center;
      border: 2px solid #1e40af;
      margin: 20px 0;
      box-sizing: border-box;
    }

    .security-notice {
      border-left: 4px solid #06b6d4;
      padding: 11px 14px;
      background: rgba(6, 182, 212, 0.04);
      border-radius: 0 6px 6px 0;
      margin: 16px 0;
    }

    .security-text {
      font-family: 'Geist', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 13.5px;
      line-height: 1.55;
      color: #475569;
      margin: 0;
    }

    .credential-box {
      background-color: #F7F9FF;
      border-left: 4px solid #3b82f6;
      padding: 13px 16px;
      border-radius: 0 8px 8px 0;
      margin: 16px 0;
    }

    .credential-item {
      margin: 6px 0;
      font-family: 'Geist', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 14px;
      color: #4A5568;
    }

    .credential-label {
      font-weight: 600;
      color: #0b1220;
    }

    .credential-value {
      color: #1e40af;
      font-family: 'Geist', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      font-weight: 600;
      background-color: #EEF3FF;
      padding: 2px 9px;
      border-radius: 6px;
      display: inline-block;
      margin-left: 8px;
      font-size: 13px;
    }

    .divider {
      height: 1px;
      background-color: #E8E8E8;
      margin: 20px 0;
      border: none;
    }

    .fallback-url {
      font-family: 'Geist Mono', 'Courier New', Courier, monospace;
      font-size: 12px;
      color: #64748B;
      word-break: break-all;
      line-height: 1.5;
      display: block;
    }

    @media only screen and (max-width: 640px) {
      .card-body { padding: 22px 18px 18px !important; }
      .email-footer { padding: 12px 18px 16px !important; }
      .email-title { font-size: 21px !important; }
    }
  </style>
</head>
<body>
${preheaderText}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#EEF3FB;">
  <tr>
    <td style="padding:28px 16px;" align="center">

      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;box-shadow:0 2px 12px rgba(14,30,64,0.08);overflow:hidden;">

        <!-- Top accent stripe -->
        <tr>
          <td style="padding:0;font-size:0;line-height:0;">
            <!--[if mso]>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600"><tr>
            <td bgcolor="#3b82f6" height="4" style="font-size:0;line-height:0;">&nbsp;</td>
            </tr></table>
            <![endif]-->
            <!--[if !mso]><!-->
            <div style="height:4px;background:linear-gradient(90deg,#1e40af 0%,#3b82f6 55%,#06b6d4 100%);font-size:0;line-height:0;">&nbsp;</div>
            <!--<![endif]-->
          </td>
        </tr>

        <!-- Card body -->
        <tr>
          <td style="padding:28px 32px 22px;" class="card-body">

            <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto 22px;">
              <tr>
                ${logoCell}
                <td style="vertical-align:middle;padding-left:10px;">
                  <span style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:17px;font-weight:600;color:#0b1220;letter-spacing:-0.02em;">Streamline<span style="color:#1e40af;">OS</span></span>
                </td>
              </tr>
            </table>

            ${content}

          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
              <tr><td height="1" bgcolor="#E8E8E8" style="font-size:0;line-height:0;">&nbsp;</td></tr>
              <tr>
                <td style="padding:14px 32px 18px;text-align:center;" class="email-footer">
                  <p style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;font-weight:600;color:#64748B;margin:0 0 3px 0;">StreamlineOS</p>
                  <p style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;color:#999;margin:0 0 4px 0;">Enterprise Resource Management &nbsp;&middot;&nbsp; <a href="mailto:${supportEmail}" style="color:#94A3B8;text-decoration:underline;">${supportEmail}</a></p>
                  <p style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;color:#999;margin:0;"><a href="${brandUrl}/legal/privacy" style="color:#94A3B8;text-decoration:underline;">Privacy Policy</a></p>
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
