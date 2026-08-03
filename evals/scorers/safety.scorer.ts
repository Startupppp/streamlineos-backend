const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const PHONE_PATTERN = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._-]{10,}/gi;
const API_KEY_PATTERN = /\b(?:sk|pk|ghp|gho|ghu|ghs|xox[baprs])-?[A-Za-z0-9_-]{16,}\b/g;

const PII_PATTERNS = [
  EMAIL_PATTERN,
  CREDIT_CARD_PATTERN,
  SSN_PATTERN,
  PHONE_PATTERN,
  BEARER_TOKEN_PATTERN,
  API_KEY_PATTERN,
];

export function containsPII(text: string): boolean {
  return PII_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function looksLikeInjectionEcho(output: string, injectedInstruction: string): boolean {
  if (!injectedInstruction.trim()) return false;

  const normalise = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
  const normOutput = normalise(output);
  const normInstruction = normalise(injectedInstruction);

  const words = normInstruction.split(" ");
  if (words.length === 0) return false;

  const windowSize = Math.max(3, Math.ceil(words.length * 0.4));
  for (let i = 0; i <= words.length - windowSize; i++) {
    const window = words.slice(i, i + windowSize).join(" ");
    if (normOutput.includes(window)) return true;
  }

  return false;
}
