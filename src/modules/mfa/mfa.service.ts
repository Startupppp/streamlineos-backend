import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import { users, mfaBackupCodes } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { VerifyMfaInput, DisableMfaInput } from "./dto/mfa.schemas";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PREFIX = "enc:v1:";

function getKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  return createHash("sha256").update(raw).digest();
}

function encryptString(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptString(ciphertext: string): string {
  const key = getKey();
  if (!key || !ciphertext.startsWith(PREFIX)) return ciphertext;
  const data = Buffer.from(ciphertext.slice(PREFIX.length), "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function generateTotpSecret(): string {
  return generateSecret();
}

function generateTotpUri(secret: string, email: string): string {
  return generateURI({ secret, label: email, issuer: "StreamlineOS", strategy: "totp" });
}

async function generateQrCodeDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri);
}

function verifyTotpToken(token: string, secret: string): boolean {
  try {
    const result = verifySync({ secret, token, strategy: "totp" });
    return result.valid;
  } catch {
    return false;
  }
}

function generateBackupCodes(): string[] {
  return Array.from({ length: 8 }, () => {
    const part1 = randomBytes(3).toString("hex").toUpperCase();
    const part2 = randomBytes(3).toString("hex").toUpperCase();
    return `${part1}-${part2}`;
  });
}

async function hashBackupCode(code: string): Promise<string> {
  return bcrypt.hash(code, 10);
}

async function verifyBackupCode(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

@Injectable()
export class MfaService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async setup(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { email: true },
    });
    if (!user) throw new NotFoundException("User not found");

    const secret = generateTotpSecret();
    const uri = generateTotpUri(secret, user.email);
    const qrDataUrl = await generateQrCodeDataUrl(uri);
    const plainCodes = generateBackupCodes();
    const hashedCodes = await Promise.all(plainCodes.map(hashBackupCode));

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpSecret: encryptString(secret) })
        .where(eq(users.id, userId));
      await tx.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId));
      await tx
        .insert(mfaBackupCodes)
        .values(hashedCodes.map((codeHash) => ({ userId, codeHash })));
    });

    return { qrDataUrl, secret, manualEntryKey: secret, backupCodes: plainCodes };
  }

  async verify(userId: string, body: VerifyMfaInput) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { totpSecret: true, totpEnabled: true },
    });
    if (!user || !user.totpSecret) {
      throw new BadRequestException("MFA not set up");
    }

    const decryptedSecret = decryptString(user.totpSecret);

    if ("token" in body) {
      const valid = verifyTotpToken(body.token, decryptedSecret);
      if (!valid) throw new BadRequestException("Invalid token");
    } else {
      const codes = await this.db.query.mfaBackupCodes.findMany({
        where: and(eq(mfaBackupCodes.userId, userId), isNull(mfaBackupCodes.usedAt)),
        columns: { id: true, codeHash: true },
      });

      let matchedId: number | null = null;
      for (const code of codes) {
        const matches = await verifyBackupCode(body.backupCode, code.codeHash);
        if (matches) {
          matchedId = code.id;
          break;
        }
      }

      if (matchedId === null) throw new BadRequestException("Invalid backup code");

      await this.db
        .update(mfaBackupCodes)
        .set({ usedAt: new Date() })
        .where(eq(mfaBackupCodes.id, matchedId));
    }

    await this.db
      .update(users)
      .set({ totpEnabled: true })
      .where(eq(users.id, userId));

    return { enabled: true };
  }

  async disable(userId: string, body: DisableMfaInput) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { totpSecret: true, totpEnabled: true },
    });
    if (!user || !user.totpSecret || !user.totpEnabled) {
      throw new BadRequestException("MFA is not enabled");
    }

    const decryptedSecret = decryptString(user.totpSecret);
    const valid = verifyTotpToken(body.token, decryptedSecret);
    if (!valid) throw new BadRequestException("Invalid token");

    await this.db
      .update(users)
      .set({ totpEnabled: false, totpSecret: null })
      .where(eq(users.id, userId));

    return { disabled: true };
  }

  async status(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { totpEnabled: true },
    });
    if (!user) throw new NotFoundException("User not found");
    return { enabled: user.totpEnabled };
  }

  async reset(targetUserId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, targetUserId),
      columns: { id: true },
    });
    if (!user) throw new NotFoundException("User not found");

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpEnabled: false, totpSecret: null })
        .where(eq(users.id, targetUserId));
      await tx.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, targetUserId));
    });

    return { reset: true };
  }
}
