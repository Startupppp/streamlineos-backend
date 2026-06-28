import { Inject, Injectable, BadRequestException } from "@nestjs/common";
import { hash, compare } from "bcryptjs";
import { desc, eq } from "drizzle-orm";
import { passwordHistory } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

const SALT_ROUNDS = 12;
const HISTORY_DEPTH = 5;

@Injectable()
export class PasswordService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, SALT_ROUNDS);
  }

  async verify(plaintext: string, hashed: string): Promise<boolean> {
    return compare(plaintext, hashed);
  }

  async checkPasswordHistory(userId: string, plaintext: string): Promise<void> {
    const history = await this.db
      .select({ passwordHash: passwordHistory.passwordHash })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, userId))
      .orderBy(desc(passwordHistory.createdAt))
      .limit(HISTORY_DEPTH);
    for (const row of history) {
      if (await compare(plaintext, row.passwordHash)) {
        throw new BadRequestException(
          `Password was used recently. Choose a password different from your last ${HISTORY_DEPTH}.`,
        );
      }
    }
  }

  async recordPasswordHistory(userId: string, passwordHash: string): Promise<void> {
    await this.db.insert(passwordHistory).values({ userId, passwordHash });
  }
}
