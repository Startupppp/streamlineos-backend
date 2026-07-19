import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { userIntegrationConnections } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { MailProvider } from "./dto/mail-schemas";

const MAIL_TOOLKITS = ["gmail", "outlook"] as const;

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

  async markNeedsReauth(accountId: number): Promise<void> {
    await this.db
      .update(userIntegrationConnections)
      .set({ status: "needs_reauth" })
      .where(eq(userIntegrationConnections.id, accountId))
      .catch(() => undefined);
  }
}
