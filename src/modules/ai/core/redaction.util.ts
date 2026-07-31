/**
 * Deterministic, regex-based PII/secret redaction applied to any free-text
 * content before it's interpolated into an LLM prompt. Intentionally
 * conservative (over-redact rather than risk a leak) — order matters since
 * later patterns must not re-match an already-inserted [REDACTED_*] placeholder.
 */

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const PHONE_PATTERN = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._-]{10,}/gi;
const API_KEY_PATTERN = /\b(?:sk|pk|ghp|gho|ghu|ghs|xox[baprs])-?[A-Za-z0-9_-]{16,}\b/g;

export function redactSensitiveData(text: string): string {
  if (!text) return text;
  return text
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
    .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED_TOKEN]")
    .replace(API_KEY_PATTERN, "[REDACTED_TOKEN]")
    .replace(SSN_PATTERN, "[REDACTED_SSN]")
    .replace(CREDIT_CARD_PATTERN, "[REDACTED_CARD]")
    .replace(PHONE_PATTERN, "[REDACTED_PHONE]");
}
