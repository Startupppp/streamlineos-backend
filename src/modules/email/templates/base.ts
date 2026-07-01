import { appUrl } from "../app-url";

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

export function getEmailTemplate({ title, preheader, content }: EmailTemplateProps): string {
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
    @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap');

    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }

    body {
      margin: 0;
      padding: 0;
      background-color: #EEF3FB;
      font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .email-title {
      font-family: 'Sora', -apple-system, 'Segoe UI', Arial, sans-serif;
      font-size: 30px;
      font-weight: 700;
      color: #0b1220;
      letter-spacing: -0.025em;
      line-height: 1.18;
      margin: 0 0 14px 0;
    }

    .email-text {
      font-family: 'DM Sans', -apple-system, 'Segoe UI', sans-serif;
      font-size: 16px;
      line-height: 1.7;
      color: #4A5568;
      margin: 0 0 20px 0;
    }

    .email-label {
      font-family: 'DM Sans', -apple-system, sans-serif;
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
      font-family: 'Sora', -apple-system, 'Segoe UI', Arial, sans-serif;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.02em;
      padding: 16px 32px;
      border-radius: 8px;
      text-align: center;
      border: 2px solid #1e40af;
      margin: 28px 0;
      box-sizing: border-box;
    }

    .security-notice {
      border-left: 4px solid #06b6d4;
      padding: 14px 18px;
      background: rgba(6, 182, 212, 0.04);
      border-radius: 0 6px 6px 0;
      margin: 24px 0;
    }

    .security-text {
      font-family: 'DM Sans', -apple-system, 'Segoe UI', sans-serif;
      font-size: 13.5px;
      line-height: 1.6;
      color: #475569;
      margin: 0;
    }

    .credential-box {
      background-color: #F7F9FF;
      border-left: 4px solid #3b82f6;
      padding: 18px 20px;
      border-radius: 0 8px 8px 0;
      margin: 24px 0;
    }

    .credential-item {
      margin: 8px 0;
      font-family: 'DM Sans', -apple-system, sans-serif;
      font-size: 14px;
      color: #4A5568;
    }

    .credential-label {
      font-weight: 600;
      color: #0b1220;
    }

    .credential-value {
      color: #1e40af;
      font-family: 'Courier New', Courier, monospace;
      background-color: #ffffff;
      padding: 3px 8px;
      border-radius: 4px;
      display: inline-block;
      margin-left: 8px;
      font-size: 13px;
    }

    .divider {
      height: 1px;
      background-color: #E8E8E8;
      margin: 28px 0;
      border: none;
    }

    .fallback-url {
      font-family: 'Courier New', Courier, monospace;
      font-size: 12px;
      color: #64748B;
      word-break: break-all;
      line-height: 1.5;
      display: block;
    }

    @media only screen and (max-width: 640px) {
      .card-body { padding: 28px 24px 24px !important; }
      .email-footer { padding: 16px 24px 28px !important; }
      .email-title { font-size: 24px !important; }
    }
  </style>
</head>
<body>
${preheaderText}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#EEF3FB;">
  <tr>
    <td style="padding:48px 20px;" align="center">

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
          <td style="padding:40px 48px 32px;" class="card-body">

            <!-- Logo lockup -->
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:36px;">
              <tr>
                <td style="vertical-align:middle;">
                  <img src="${appUrl}/logo-email.svg" alt="StreamlineOS" width="48" height="48" style="display:block;border:0;width:48px;height:48px;border-radius:10px;" border="0">
                </td>
                <td style="vertical-align:middle;padding-left:10px;">
                  <span style="font-family:'Sora',-apple-system,'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:600;color:#0b1220;letter-spacing:-0.02em;">StreamlineOS</span>
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
                <td style="padding:20px 48px 28px;text-align:center;" class="email-footer">
                  <p style="font-family:'DM Sans',-apple-system,'Segoe UI',sans-serif;font-size:12px;font-weight:600;color:#64748B;margin:0 0 4px 0;">StreamlineOS</p>
                  <p style="font-family:'DM Sans',-apple-system,'Segoe UI',sans-serif;font-size:12px;color:#999;margin:0 0 6px 0;">Enterprise Resource Management &nbsp;·&nbsp; <a href="mailto:support@streamlineos.app" style="color:#94A3B8;text-decoration:underline;">support@streamlineos.app</a></p>
                  <p style="font-family:'DM Sans',-apple-system,'Segoe UI',sans-serif;font-size:12px;color:#999;margin:0;">
                    <a href="https://streamlineos.app/unsubscribe" style="color:#94A3B8;text-decoration:underline;">Unsubscribe</a>
                    &nbsp;·&nbsp;
                    <a href="https://streamlineos.app/privacy" style="color:#94A3B8;text-decoration:underline;">Privacy Policy</a>
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
