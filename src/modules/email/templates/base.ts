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
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  ${preheader ? `<meta name="description" content="${preheader}">` : ''}
  <title>${title}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

    body {
      margin: 0;
      padding: 0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif;
      background-color: #f6f9fc;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .email-wrapper {
      width: 100%;
      background-color: #f6f9fc;
      padding: 40px 0;
    }

    .email-container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
    }

    .email-header {
      background: linear-gradient(135deg, #0f2b7f 0%, #1e40af 100%);
      padding: 40px 48px;
      text-align: center;
    }

    .logo {
      width: 180px;
      height: auto;
      margin-bottom: 16px;
    }

    .email-body {
      padding: 48px;
      color: #334155;
      line-height: 1.6;
    }

    .email-title {
      font-size: 24px;
      font-weight: 700;
      color: #0f172a;
      margin: 0 0 24px 0;
      line-height: 1.3;
    }

    .email-text {
      font-size: 16px;
      color: #475569;
      margin: 0 0 16px 0;
      line-height: 1.6;
    }

    .email-button {
      display: inline-block;
      padding: 14px 32px;
      background: linear-gradient(135deg, #0f2b7f 0%, #1e40af 100%);
      color: #ffffff !important;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      font-size: 16px;
      margin: 24px 0;
      transition: transform 0.2s;
    }

    .email-button:hover {
      transform: translateY(-2px);
    }

    .credential-box {
      background-color: #f8fafc;
      border-left: 4px solid #0f2b7f;
      padding: 20px;
      border-radius: 8px;
      margin: 24px 0;
    }

    .credential-item {
      margin: 8px 0;
      font-size: 15px;
    }

    .credential-label {
      font-weight: 600;
      color: #0f172a;
    }

    .credential-value {
      color: #0f2b7f;
      font-family: 'Monaco', 'Courier New', monospace;
      background-color: #ffffff;
      padding: 4px 8px;
      border-radius: 4px;
      display: inline-block;
      margin-left: 8px;
    }

    .divider {
      height: 1px;
      background-color: #e2e8f0;
      margin: 32px 0;
    }

    .email-footer {
      background-color: #f8fafc;
      padding: 32px 48px;
      text-align: center;
      border-top: 1px solid #e2e8f0;
    }

    .footer-text {
      font-size: 14px;
      color: #64748b;
      margin: 8px 0;
    }

    .footer-link {
      color: #0f2b7f;
      text-decoration: none;
      font-weight: 500;
    }

    .security-notice {
      background-color: #fef3c7;
      border-left: 4px solid #f59e0b;
      padding: 16px;
      border-radius: 8px;
      margin: 24px 0;
    }

    .security-text {
      font-size: 14px;
      color: #92400e;
      margin: 0;
    }

    @media only screen and (max-width: 600px) {
      .email-body, .email-header, .email-footer {
        padding: 32px 24px !important;
      }

      .email-title {
        font-size: 20px;
      }

      .email-text {
        font-size: 15px;
      }
    }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <div class="email-container">
      <div class="email-header">
        <h1 style="color: #ffffff; font-size: 28px; font-weight: 700; margin: 0;">
          StreamlineOS
        </h1>
      </div>

      <div class="email-body">
        ${content}
      </div>

      <div class="email-footer">
        <p class="footer-text">
          <strong>StreamlineOS</strong><br>
          Enterprise Resource Management System
        </p>
        <p class="footer-text">
          Need help? Contact us at <a href="mailto:support@streamlineos.app" class="footer-link">support@streamlineos.app</a>
        </p>
        <p class="footer-text" style="margin-top: 16px; font-size: 12px; color: #94a3b8;">
          This is an automated email. Please do not reply to this message.
        </p>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}
