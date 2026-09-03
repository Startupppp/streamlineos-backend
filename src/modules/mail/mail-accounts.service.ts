import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { userIntegrationConnections } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { MailProvider } from "./dto/mail-schemas";

const MAIL_TOOLKITS = ["gmail", "outlook"] as const;

/** One UPDATE per this many account ids. Documented bound, not a reachable one:
 *  a person holds a handful of mailboxes, so the chunk exists so the statement
 *  stays bounded if a caller ever hands over a whole org. */
const REAUTH_MARK_CHUNK = 100;

const ACCOUNT_COLUMNS = {
  id: userIntegrationConnections.id,
  toolkit: userIntegrationConnections.toolkit,
  accountEmail: userIntegrationConnections.accountEmail,
  accountLabel: userIntegrationConnections.accountLabel,
  status: userIntegrationConnections.status,
  isPrimary: userIntegrationConnections.isPrimary,
  composioConnectedAccountId: userIntegrationConnections.composioConnectedAccountId,
} as const;

export interface MailAccount {
  id: number;
  provider: MailProvider;
  accountEmail: string | null;
  accountLabel: string | null;
  status: "active" | "needs_reauth" | "disabled";
  isPrimary: boolean;
  composioConnectedAccountId: string;
}

@Injectable()
export class MailAccountsService {
  private readonly logger = new Logger(MailAccountsService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listAccounts(orgId: string, userId: string): Promise<MailAccount[]> {
    const rows = await this.db
      .select(ACCOUNT_COLUMNS)
      .from(userIntegrationConnections)
      .where(
        and(
          eq(userIntegrationConnections.orgId, orgId),
          eq(userIntegrationConnections.userId, userId),
          inArray(userIntegrationConnections.toolkit, [...MAIL_TOOLKITS]),
        ),
      );
    return rows.map((r) => ({
      id: r.id,
      provider: r.toolkit === "gmail" ? "gmail" : "outlook",
      accountEmail: r.accountEmail,
      accountLabel: r.accountLabel,
      status: r.status,
      isPrimary: r.isPrimary,
      composioConnectedAccountId: r.composioConnectedAccountId,
    }));
  }

  async assertOwnedConnection(
    orgId: string,
    userId: string,
    accountId: number,
  ): Promise<MailAccount> {
    const rows = await this.db
      .select(ACCOUNT_COLUMNS)
      .from(userIntegrationConnections)
      .where(
        and(
          eq(userIntegrationConnections.id, accountId),
          eq(userIntegrationConnections.orgId, orgId),
          eq(userIntegrationConnections.userId, userId),
          inArray(userIntegrationConnections.toolkit, [...MAIL_TOOLKITS]),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("Mail account not found");
    return {
      id: row.id,
      provider: row.toolkit === "gmail" ? "gmail" : "outlook",
      accountEmail: row.accountEmail,
      accountLabel: row.accountLabel,
      status: row.status,
      isPrimary: row.isPrimary,
      composioConnectedAccountId: row.composioConnectedAccountId,
    };
  }

  async markNeedsReauth(accountId: number, orgId: string): Promise<void> {
    await this.markNeedsReauthMany([accountId], orgId);
  }

  /**
   * One UPDATE for every account whose provider grant just failed, instead of one per
   * account. It never rejects — every caller is on an error path and about to rethrow the
   * provider's own error, so throwing here would replace the real cause — but the failure is
   * LOGGED rather than discarded: the previous `.catch(() => undefined)` left a revoked
   * mailbox reading `active` forever with no signal anywhere, so the account was never
   * offered a reconnect and mail silently stopped arriving.
   */
  async markNeedsReauthMany(accountIds: readonly number[], orgId: string): Promise<void> {
    const ids = [...new Set(accountIds)];
    for (let i = 0; i < ids.length; i += REAUTH_MARK_CHUNK) {
      const chunk = ids.slice(i, i + REAUTH_MARK_CHUNK);
      try {
        await this.db
          .update(userIntegrationConnections)
          .set({ status: "needs_reauth" })
          .where(
            and(
              inArray(userIntegrationConnections.id, chunk),
              eq(userIntegrationConnections.orgId, orgId),
            ),
          );
      } catch (error) {
        this.logger.error(
          `mail: could not flag account(s) ${chunk.join(",")} as needs_reauth for org ${orgId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
