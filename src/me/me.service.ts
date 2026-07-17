import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, desc, count, gte, and, SQL } from "drizzle-orm";
import { DRIZZLE } from "../db/drizzle.constants";
import { type Db } from "../db/drizzle.module";
import { users, loginHistory, userSessions, devices, accounts } from "../db/schema";
import {
  decrypt,
  decryptBankDetails,
  encryptBankDetails,
} from "../modules/onboarding/crypto.helpers";
import type { UpdateProfileInput } from "./dto/me.schemas";
import { withClientInfo, withDeviceClientInfo } from "../common/http/parse-user-agent";

@Injectable()
export class MeService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getProfile(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
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

  async getLoginHistory(userId: string, page: number, limit: number, success?: boolean) {
    const offset = (page - 1) * limit;
    const conditions: SQL[] = [eq(loginHistory.userId, userId)];
    if (success !== undefined) conditions.push(eq(loginHistory.success, success));
    const where = and(...conditions);
    const [rows, countResult] = await Promise.all([
      this.db.query.loginHistory.findMany({
        where,
        orderBy: [desc(loginHistory.createdAt)],
        limit,
        offset,
      }),
      this.db.select({ count: count() }).from(loginHistory).where(where),
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

    const [loginsToday, failedLoginsLast7Days, activeSessions] = await Promise.all([
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
    ]);

    return {
      loginsToday: loginsToday[0]?.count ?? 0,
      failedLoginsLast7Days: failedLoginsLast7Days[0]?.count ?? 0,
      activeSessions: activeSessions[0]?.count ?? 0,
      passwordResetsLast7Days: 0,
    };
  }
}
