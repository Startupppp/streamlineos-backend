import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq, desc, count, gt, gte, and, isNull, or, SQL } from "drizzle-orm";
import { DRIZZLE } from "../db/drizzle.constants";
import { type Db } from "../db/drizzle.module";
import { users, loginHistory, userSessions } from "../db/schema";
import type { UpdateProfileInput } from "./dto/me.schemas";
import { withClientInfo } from "../common/http/parse-user-agent";
import { readOrgDisplay, type OrgDisplay } from "./org-display";
import { EmploymentFactsService } from "../modules/directory/employment-facts.service";
import { syncCanonicalSensitiveFields } from "../common/hr/sync-canonical-sensitive-fields";
import { CacheService } from "../common/cache/cache.service";
import { CACHE_KEYS } from "../common/cache/cache-keys";
import { registerAfterCommit } from "../common/tenant/tenant-context";

const SESSION_PROJECTED_PROFILE_FIELDS = [
  "firstName",
  "lastName",
  "name",
  "image",
] as const;

@Injectable()
export class MeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly employmentFacts: EmploymentFactsService,
    private readonly cache: CacheService,
  ) {}

  private async invalidateSessionProfile(userId: string): Promise<void> {
    const invalidate = () =>
      this.cache.invalidate(CACHE_KEYS.userSession(userId));
    await invalidate();
    registerAfterCommit(invalidate);
  }

  getOrgDisplay(organizationId: string): Promise<OrgDisplay> {
    return readOrgDisplay(this.db, organizationId);
  }

  async getProfile(userId: string, orgId: string | null) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        totpSecret: false,
      },
    });

    if (!user) throw new NotFoundException("User not found");

    const sensitive = orgId
      ? await this.employmentFacts.getSensitiveFacts(orgId, userId)
      : null;

    return {
      ...user,
      taxId: sensitive?.taxId ?? null,
      bankDetails: sensitive?.bankDetails ?? null,
    };
  }

  async updateProfile(
    userId: string,
    orgId: string | null,
    input: UpdateProfileInput,
  ): Promise<{ success: true }> {
    const setFields = {
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
      ...(input.firstName !== undefined && input.lastName !== undefined
        ? { name: `${input.firstName} ${input.lastName}` }
        : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.image !== undefined ? { image: input.image } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.whatsappNumber !== undefined ? { whatsappNumber: input.whatsappNumber } : {}),
      ...(input.emergencyContact !== undefined ? { emergencyContact: input.emergencyContact } : {}),
    };

    if (input.bankDetails !== undefined && !orgId)
      throw new BadRequestException(
        "Bank details belong to an organization — select a workspace first",
      );

    await this.db.transaction(async (tx) => {
      if (Object.keys(setFields).length > 0)
        await tx.update(users).set(setFields).where(eq(users.id, userId));

      if (input.bankDetails !== undefined && orgId)
        await syncCanonicalSensitiveFields(tx, orgId, userId, {
          bankDetails: input.bankDetails,
        });
    });

    const touchesSession = SESSION_PROJECTED_PROFILE_FIELDS.some(
      (field) => field in setFields,
    );
    if (touchesSession) await this.invalidateSessionProfile(userId);

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
      // Same "still active" predicate as `SessionsService.list` and
      // `enforceMaxSessions`. Without the expiry half this counted every
      // session the user had ever opened — nothing prunes `user_sessions` —
      // so the number beside the device list disagreed with the list itself.
      this.db.select({ count: count() }).from(userSessions).where(
        and(
          eq(userSessions.userId, userId),
          eq(userSessions.isRevoked, false),
          or(isNull(userSessions.expiresAt), gt(userSessions.expiresAt, now)),
        ),
      ),
    ]);

    return {
      loginsToday: loginsToday[0]?.count ?? 0,
      failedLoginsLast7Days: failedLoginsLast7Days[0]?.count ?? 0,
      activeSessions: activeSessions[0]?.count ?? 0,
    };
  }
}
