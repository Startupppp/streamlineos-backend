import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const DEK_LENGTH = 32;
const ENVELOPE_PREFIX = "enc:v2:";
const ENVELOPE_SEGMENTS = 5;

export interface KeyProvider {
  readonly activeKeyId: string;
  wrap(dek: Buffer): { keyId: string; wrapped: string };
  unwrap(keyId: string, wrapped: string): Buffer;
}

function sealWith(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function openWith(key: Buffer, sealed: string): Buffer {
  const data = Buffer.from(sealed, "base64");
  if (data.length < IV_LENGTH + TAG_LENGTH) throw new Error("Envelope ciphertext is truncated");
  const decipher = createDecipheriv(ALGORITHM, key, data.subarray(0, IV_LENGTH));
  decipher.setAuthTag(data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  return Buffer.concat([
    decipher.update(data.subarray(IV_LENGTH + TAG_LENGTH)),
    decipher.final(),
  ]);
}

export class EnvKeyProvider implements KeyProvider {
  private readonly keys: ReadonlyMap<string, Buffer>;
  readonly activeKeyId: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const keys = new Map<string, Buffer>();
    const register = (version: number, raw: string | undefined): void => {
      if (!raw) return;
      keys.set(`kek:v${version}`, createHash("sha256").update(raw).digest());
    };
    register(1, env.ENCRYPTION_KEY);
    for (const [name, value] of Object.entries(env)) {
      const match = /^ENCRYPTION_KEY_V(\d+)$/.exec(name);
      if (match?.[1]) register(Number(match[1]), value);
    }
    this.keys = keys;
    const versions = [...keys.keys()].map((id) => Number(id.slice("kek:v".length)));
    this.activeKeyId = versions.length === 0 ? "" : `kek:v${Math.max(...versions)}`;
  }

  wrap(dek: Buffer): { keyId: string; wrapped: string } {
    const kek = this.keys.get(this.activeKeyId);
    if (!kek)
      throw new Error(
        "No encryption key is configured (ENCRYPTION_KEY) — refusing to store sensitive data",
      );
    return { keyId: this.activeKeyId, wrapped: sealWith(kek, dek) };
  }

  unwrap(keyId: string, wrapped: string): Buffer {
    const kek = this.keys.get(keyId);
    if (!kek)
      throw new Error(
        `Encryption key ${keyId || "(unset)"} is not configured — refusing to decrypt sensitive data`,
      );
    return openWith(kek, wrapped);
  }
}

let provider: KeyProvider | null = null;

export function setKeyProvider(next: KeyProvider): void {
  provider = next;
}

export function resetKeyProvider(): void {
  provider = null;
}

export function getKeyProvider(): KeyProvider {
  if (!provider) provider = new EnvKeyProvider();
  return provider;
}

export function isEnvelopeCiphertext(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX) && value.split(":").length === ENVELOPE_SEGMENTS;
}

export function keyReferenceOf(value: string): string | null {
  if (!isEnvelopeCiphertext(value)) return null;
  const [, , keyVersion] = value.split(":");
  return keyVersion ? `kek:${keyVersion}` : null;
}

export function encryptEnvelope(plaintext: string): string {
  const dek = randomBytes(DEK_LENGTH);
  const { keyId, wrapped } = getKeyProvider().wrap(dek);
  const body = sealWith(dek, Buffer.from(plaintext, "utf8"));
  dek.fill(0);
  return `${ENVELOPE_PREFIX}${keyId.slice("kek:".length)}:${wrapped}:${body}`;
}

export function decryptEnvelope(value: string): string {
  if (!isEnvelopeCiphertext(value))
    throw new Error("Value is not envelope ciphertext — refusing to return it");
  const [, , keyVersion, wrapped, body] = value.split(":");
  if (!keyVersion || !wrapped || !body) throw new Error("Envelope ciphertext is malformed");
  const dek = getKeyProvider().unwrap(`kek:${keyVersion}`, wrapped);
  try {
    return openWith(dek, body).toString("utf8");
  } finally {
    dek.fill(0);
  }
}
