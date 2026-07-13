import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, desc, count, gte, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { DRIZZLE } from "../db/drizzle.constants";
import { type Db } from "../db/drizzle.module";
import { users, passwordHistory, loginHistory, userSessions, passwordResetTokens, devices, accounts } from "../db/schema";
import {
  decrypt,
  decryptBankDetails,
  encryptBankDetails,
} from "../modules/onboarding/crypto.helpers";
import type { UpdateProfileInput } from "./dto/me.schemas";
import { withClientInfo, withDeviceClientInfo } from "../common/http/parse-user-agent";

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

export const setupPasswordSchema = z.object({
  password: passwordRules,
});

export type SetupPasswordInput = z.infer<typeof setupPasswordSchema>;

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

  async setupPassword(userId: string, password: string): Promise<{ success: true }> {
    return this.forceChangePassword(userId, { newPassword: password });
  }

  async getLoginHistory(userId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const [rows, countResult] = await Promise.all([
      this.db.query.loginHistory.findMany({
        where: eq(loginHistory.userId, userId),
        orderBy: [desc(loginHistory.createdAt)],
        limit,
        offset,
      }),
      this.db.select({ count: count() }).from(loginHistory).where(eq(loginHistory.userId, userId)),
    ]);
    return {
      data: rows.map(withClientInfo),
      total: countResult[0]?.count ?? 0,
      page,
      limit,
    };
  }

  async getDevices(userId: string) {
    const rows = await this.db.query.devices.findMany({
      where: eq(devices.userId, userId),
      orderBy: [desc(devices.lastSeenAt)],
    });
    return rows.map(withDeviceClientInfo);
  }

  async deleteDevice(userId: string, deviceId: string): Promise<{ message: string }> {
    const device = await this.db.query.devices.findFirst({
      where: and(eq(devices.id, deviceId), eq(devices.userId, userId)),
    });
    if (!device) throw new NotFoundException("Device not found");
    await this.db.delete(devices).where(and(eq(devices.id, deviceId), eq(devices.userId, userId)));
    return { message: "Device removed" };
  }

  async trustDevice(userId: string, deviceId: string): Promise<{ message: string }> {
    const device = await this.db.query.devices.findFirst({
      where: and(eq(devices.id, deviceId), eq(devices.userId, userId)),
    });
    if (!device) throw new NotFoundException("Device not found");
    await this.db
      .update(devices)
      .set({ trusted: true })
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)));
    return { message: "Device trusted" };
  }

  async getConnectedAccounts(userId: string) {
    return this.db
      .select({ provider: accounts.provider, providerAccountId: accounts.providerAccountId })
      .from(accounts)
      .where(eq(accounts.userId, userId));
  }

  async unlinkProvider(userId: string, provider: string) {
    const existing = await this.db
      .select({ provider: accounts.provider })
      .from(accounts)
      .where(eq(accounts.userId, userId));
    if (existing.length <= 1) {
      throw new BadRequestException("Cannot unlink the only connected account");
    }
    await this.db
      .delete(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.provider, provider)));
    return { success: true as const };
  }

  async getAuthAnalytics(userId: string) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { email: true },
    });

    const [loginsToday, failedLoginsLast7Days, activeSessions, passwordResetsLast7Days] = await Promise.all([
      this.db.select({ count: count() }).from(loginHistory).where(
        and(
          eq(loginHistory.userId, userId),
          eq(loginHistory.success, true),
          gte(loginHistory.createdAt, startOfToday),
        ),
      ),
      this.db.select({ count: count() }).from(loginHistory).where(
        and(
          eq(loginHistory.userId, userId),
          eq(loginHistory.success, false),
          gte(loginHistory.createdAt, sevenDaysAgo),
        ),
      ),
      this.db.select({ count: count() }).from(userSessions).where(
        and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)),
      ),
      user
        ? this.db.select({ count: count() }).from(passwordResetTokens).where(
            and(
              eq(passwordResetTokens.email, user.email),
              gte(passwordResetTokens.createdAt, sevenDaysAgo),
            ),
          )
        : Promise.resolve([{ count: 0 }]),
    ]);

    return {
      loginsToday: loginsToday[0]?.count ?? 0,
      failedLoginsLast7Days: failedLoginsLast7Days[0]?.count ?? 0,
      activeSessions: activeSessions[0]?.count ?? 0,
      passwordResetsLast7Days: passwordResetsLast7Days[0]?.count ?? 0,
    };
  }
}
