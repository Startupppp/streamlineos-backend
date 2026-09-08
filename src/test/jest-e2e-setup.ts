process.env.NODE_ENV = "test";

for (const key of [
  "ZEPTOMAIL_TOKEN",
  "RESEND_API_KEY",
  "ALERT_WEBHOOK_URL",
  "SLACK_WEBHOOK_URL",
]) {
  delete process.env[key];
}
