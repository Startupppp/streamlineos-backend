import { Injectable } from "@nestjs/common";
import { hash, compare } from "bcryptjs";

const SALT_ROUNDS = 12;

@Injectable()
export class PasswordService {
  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, SALT_ROUNDS);
  }

  async verify(plaintext: string, hashed: string): Promise<boolean> {
    return compare(plaintext, hashed);
  }
}
