import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, desc } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { DRIZZLE } from "../db/drizzle.constants";
import { type Db } from "../db/drizzle.module";
import { users, passwordHistory } from "../db/schema";
import {
  decrypt,
  decryptBankDetails,
  encryptBankDetails,
} from "../modules/onboarding/crypto.helpers";
import type { UpdateProfileInput } from "./dto/me.schemas";

const SPECIAL_CHARS = "@$!%*?&#^_+=\\-";
const PASSWORD_HISTORY_LIMIT = 5;

const passwordRules = z.string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must not exceed 128 characters")
  .regex(/[a-z]/, "At least one lowercase letter required")
  .regex(/[A-Z]/, "At least one uppercase letter required")
  .regex(/\d/, "At least one number required")
  .regex(new RegExp(`[${SPECIAL_CHARS.replace(/[-\\]/g, "\\$&")}]`), "At least one special character required");

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: passwordRules,
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const forceChangePasswordSchema = z.object({
  newPassword: passwordRules,
});

export type ForceChangePasswordInput = z.infer<typeof forceChangePasswordSchema>;

@Injectable()
export class MeService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async changePassword(userId: string, input: ChangePasswordInput): Promise<{ success: true }> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, password: true },
    });

    if (!user?.password) throw new NotFoundException("User not found");

    const isCurrentValid = await bcrypt.compare(input.currentPassword, user.password);
    if (!isCurrentValid) throw new BadRequestException("Current password is incorrect");

    const history = await this.db.query.passwordHistory.findMany({
      where: eq(passwordHistory.userId, userId),
      orderBy: [desc(passwordHistory.createdAt)],
      limit: PASSWORD_HISTORY_LIMIT,
    });

    for (const entry of history) {
      const isReused = await bcrypt.compare(input.newPassword, entry.passwordHash);
      if (isReused) {
        throw new BadRequestException(
          `Cannot reuse one of your last ${PASSWORD_HISTORY_LIMIT} passwords`,
        );
      }
    }

    const newHash = await bcrypt.hash(input.newPassword, 12);

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          password: newHash,
          isPasswordChangeRequired: false,
          passwordChangedAt: new Date(),
        })
        .where(eq(users.id, userId));

      await tx.insert(passwordHistory).values({ userId, passwordHash: newHash });

      const allHistory = await tx.query.passwordHistory.findMany({
        where: eq(passwordHistory.userId, userId),
        orderBy: [desc(passwordHistory.createdAt)],
        columns: { id: true },
      });

      if (allHistory.length > PASSWORD_HISTORY_LIMIT) {
        const toDelete = allHistory.slice(PASSWORD_HISTORY_LIMIT);
        for (const entry of toDelete) {
          await tx.delete(passwordHistory).where(eq(passwordHistory.id, entry.id));
        }
      }
    });

    return { success: true };
  }

  async forceChangePassword(userId: string, input: ForceChangePasswordInput): Promise<{ success: true }> {
    const newHash = await bcrypt.hash(input.newPassword, 12);

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ password: newHash, isPasswordChangeRequired: false, passwordChangedAt: new Date() })
        .where(eq(users.id, userId));

      await tx.insert(passwordHistory).values({ userId, passwordHash: newHash });

      const allHistory = await tx.query.passwordHistory.findMany({
        where: eq(passwordHistory.userId, userId),
        orderBy: [desc(passwordHistory.createdAt)],
        columns: { id: true },
      });

      if (allHistory.length > PASSWORD_HISTORY_LIMIT) {
        const toDelete = allHistory.slice(PASSWORD_HISTORY_LIMIT);
        for (const entry of toDelete) {
          await tx.delete(passwordHistory).where(eq(passwordHistory.id, entry.id));
        }
      }
    });

    return { success: true };
  }

  async getProfile(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        password: false,
        totpSecret: false,
        googleRefreshToken: false,
      },
    });

    if (!user) throw new NotFoundException("User not found");

    const { bankDetails, taxId, ...rest } = user;
    return {
      ...rest,
      taxId: taxId ? decrypt(taxId) : null,
      bankDetails: decryptBankDetails(bankDetails),
    };
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<{ success: true }> {
    const setFields = {
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
      ...(input.firstName !== undefined && input.lastName !== undefined
        ? { name: `${input.firstName} ${input.lastName}` }
        : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.whatsappNumber !== undefined ? { whatsappNumber: input.whatsappNumber } : {}),
      ...(input.emergencyContact !== undefined ? { emergencyContact: input.emergencyContact } : {}),
      ...(input.bankDetails !== undefined
        ? { bankDetails: encryptBankDetails(input.bankDetails) }
        : {}),
    };

    await this.db.update(users).set(setFields).where(eq(users.id, userId));

    return { success: true };
  }
}
