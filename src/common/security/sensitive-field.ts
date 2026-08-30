import {
  decryptEnvelope,
  encryptEnvelope,
  isEnvelopeCiphertext,
  keyReferenceOf,
} from "./envelope-encryption";
import { decrypt as decryptLegacy } from "../../modules/hr/onboarding/core/crypto.helpers";

const LEGACY_PREFIX = "enc:v1:";

export function readSensitive(stored: string): string {
  if (isEnvelopeCiphertext(stored)) return decryptEnvelope(stored);
  if (stored.startsWith(LEGACY_PREFIX)) return decryptLegacy(stored);
  throw new Error("Stored sensitive value is not encrypted — refusing to return it");
}

export function sealSensitive(value: string): string {
  return encryptEnvelope(value.startsWith(LEGACY_PREFIX) ? decryptLegacy(value) : value);
}

export function isSealed(stored: string): boolean {
  return isEnvelopeCiphertext(stored) || stored.startsWith(LEGACY_PREFIX);
}

export function sealKeyReference(stored: string): string | null {
  if (stored.startsWith(LEGACY_PREFIX)) return "legacy:v1";
  return keyReferenceOf(stored);
}

export function readSensitiveJson<T>(stored: string, parse: (value: unknown) => T): T {
  return parse(JSON.parse(readSensitive(stored)));
}

export function sealSensitiveJson(value: unknown): string {
  return encryptEnvelope(JSON.stringify(value));
}
