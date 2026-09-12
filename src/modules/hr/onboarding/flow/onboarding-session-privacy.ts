export const ONBOARDING_DRAFT_SECRET_KEYS: readonly string[] = [
  "accountNumber",
  "accountnumber",
  "bankAccountNumber",
  "routingCode",
  "routingNumber",
  "iban",
  "swift",
  "ifsc",
  "statutory",
  "taxId",
  "pan",
  "panNumber",
  "ssn",
  "uan",
  "pfUanNumber",
  "esi",
  "esiIpNumber",
  "aadhaar",
  "aadhaarNumber",
  "nationalId",
  "bankDetails",
];

const SECRET_KEY_SET = new Set(ONBOARDING_DRAFT_SECRET_KEYS.map((key) => key.toLowerCase()));

const MAX_DEPTH = 8;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => stripValue(item, depth + 1));
  if (!isPlainRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_SET.has(key.toLowerCase())) continue;
    out[key] = stripValue(entry, depth + 1);
  }
  return out;
}

export function stripOnboardingDraftSecrets(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const stripped = stripValue(data, 0);
  return isPlainRecord(stripped) ? stripped : {};
}
