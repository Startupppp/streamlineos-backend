import { EMAIL_THEME } from "../branding";

const { font: FONT } = EMAIL_THEME;

export function buildEmailStyles(): string {
  return `  <style>
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
    .kv-value a,
    .fallback-url a,
    .credential-value a {
      color: inherit !important;
      text-decoration: none !important;
      font-weight: inherit !important;
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
  </style>`;
}
