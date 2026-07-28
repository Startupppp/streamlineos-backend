const PRIVATE_IP_PATTERN =
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|localhost)/i;

export function assertSafeWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (PRIVATE_IP_PATTERN.test(parsed.hostname))
    throw new Error("SSRF: private/internal URLs are blocked");
}
