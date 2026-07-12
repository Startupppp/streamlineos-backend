import { Injectable } from "@nestjs/common";
import { randomBytes, randomInt } from "node:crypto";
import { hashToken } from "../../common/security/token.util";
import { appUrl } from "../email/app-url";

const ACCESS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0, I/1 ambiguity

@Injectable()
export class SignTokensService {
  generateSigningToken(): string {
    return randomBytes(32).toString("hex");
  }

  hash(raw: string): string {
    return hashToken(raw);
  }

  generateAccessCode(length = 8): string {
    let out = "";
    for (let i = 0; i < length; i++) {
      out += ACCESS_CODE_ALPHABET[randomInt(0, ACCESS_CODE_ALPHABET.length)];
    }
    return out;
  }

  generateOtp(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, "0");
  }

  buildSigningUrl(recipientId: number, token: string): string {
    return `${appUrl}/sign/session/${recipientId}?token=${token}`;
  }

  buildPublicFormUrl(slug: string): string {
    return `${appUrl}/sign/forms/${slug}`;
  }
}
