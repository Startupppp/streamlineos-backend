import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, ne, inArray } from "drizzle-orm";
import {
  userIntegrationConnections,
  type IntegrationToolkit,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { ComposioGateway } from "./composio.gateway";

const CONNECTION_COLUMNS = {
  id: userIntegrationConnections.id,
  status: userIntegrationConnections.status,
  toolkit: userIntegrationConnections.toolkit,
  isPrimary: userIntegrationConnections.isPrimary,
  createdAt: userIntegrationConnections.createdAt,
  accountEmail: userIntegrationConnections.accountEmail,
  accountLabel: userIntegrationConnections.accountLabel,
} as const;

const OWNED_CONNECTION_COLUMNS = {
  id: userIntegrationConnections.id,
  isPrimary: userIntegrationConnections.isPrimary,
  composioConnectedAccountId:
    userIntegrationConnections.composioConnectedAccountId,
} as const;

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly gateway: ComposioGateway,
  ) {}

  listConnections(orgId: string, userId: string) {
    return this.db
      .select(CONNECTION_COLUMNS)
      .from(userIntegrationConnections)
      .where(
        and(
          eq(userIntegrationConnections.orgId, orgId),
          eq(userIntegrationConnections.userId, userId),
        ),
      )
      .orderBy(
        desc(userIntegrationConnections.isPrimary),
        desc(userIntegrationConnections.createdAt),
      )
      .limit(50);
  }

  async initiate(userId: string, toolkit: IntegrationToolkit, returnPath?: "/calendar" | "/mail") {
    const defaultPath = toolkit === "gmail" ? "/mail" : "/calendar";
    const resolvedPath = returnPath ?? defaultPath;
    const callbackUrl = `${this.config.APP_URL}${resolvedPath}`;
    return this.gateway.initiateConnection(userId, toolkit, callbackUrl);
  }

  async finalize(orgId: string, userId: string, connectedAccountId: string) {
    const account = await this.gateway.getOwnedConnectedAccount(
      userId,
      connectedAccountId,
    );
    if (!account) {
      throw new ForbiddenException(
        "Connected account does not belong to the current user",
      );
    }
    if (account.status.toUpperCase() !== "ACTIVE") {
      throw new BadRequestException(
        "Connection is not active yet. Complete the authorization and try again.",
      );
    }
    const toolkit = this.toToolkit(account.toolkitSlug);
    const email =
      (await this.gateway.getAccountEmail(userId, account.id, toolkit)) ??
      account.email;
    const { row, staleComposioIds } = await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: userIntegrationConnections.id })
        .from(userIntegrationConnections)
        .where(
          and(
            eq(userIntegrationConnections.orgId, orgId),
            eq(userIntegrationConnections.userId, userId),
          ),
        )
        .limit(1);
      const rows = await tx
        .insert(userIntegrationConnections)
        .values({
          orgId,
          userId,
          toolkit,
          composioConnectedAccountId: account.id,
          accountEmail: email,
          accountLabel: email,
          status: "active",
          isPrimary: existing.length === 0,
          scope: "user",
        })
        .onConflictDoUpdate({
          target: userIntegrationConnections.composioConnectedAccountId,
          set: {
            status: "active",
            accountEmail: email,
            accountLabel: email,
            updatedAt: new Date(),
          },
        })
        .returning(CONNECTION_COLUMNS);
      const saved = rows[0];
      if (!saved) throw new BadRequestException("Failed to save connection");

      let staleComposioIds: string[] = [];
      let madePrimary = false;
      if (email) {
        const dupes = await tx
          .select({
            id: userIntegrationConnections.id,
            composioConnectedAccountId:
              userIntegrationConnections.composioConnectedAccountId,
            isPrimary: userIntegrationConnections.isPrimary,
          })
          .from(userIntegrationConnections)
          .where(
            and(
              eq(userIntegrationConnections.orgId, orgId),
              eq(userIntegrationConnections.userId, userId),
              eq(userIntegrationConnections.toolkit, toolkit),
              eq(userIntegrationConnections.accountEmail, email),
              ne(
                userIntegrationConnections.composioConnectedAccountId,
                account.id,
              ),
            ),
          );
        if (dupes.length > 0) {
          staleComposioIds = dupes.map((d) => d.composioConnectedAccountId);
          await tx.delete(userIntegrationConnections).where(
            inArray(
              userIntegrationConnections.id,
              dupes.map((d) => d.id),
            ),
          );
          if (!saved.isPrimary && dupes.some((d) => d.isPrimary)) {
            await tx
              .update(userIntegrationConnections)
              .set({ isPrimary: true })
              .where(eq(userIntegrationConnections.id, saved.id));
            madePrimary = true;
          }
        }
      }
      return {
        row: madePrimary ? { ...saved, isPrimary: true } : saved,
        staleComposioIds,
      };
    });

    for (const staleId of staleComposioIds) {
      try {
        await this.gateway.deleteConnectedAccount(staleId);
      } catch (error) {
        this.logger.warn(
          `Failed to delete duplicate Composio account ${staleId}: ${String(error)}`,
        );
      }
    }
    return row;
  }

  async disconnect(orgId: string, userId: string, connectionId: number) {
    const row = await this.ownedConnection(orgId, userId, connectionId);
    await this.db.transaction(async (tx) => {
      await tx
        .delete(userIntegrationConnections)
        .where(
          and(
            eq(userIntegrationConnections.id, connectionId),
            eq(userIntegrationConnections.orgId, orgId),
            eq(userIntegrationConnections.userId, userId),
          ),
        );
      if (row.isPrimary) {
        const next = await tx
          .select({ id: userIntegrationConnections.id })
          .from(userIntegrationConnections)
          .where(
            and(
              eq(userIntegrationConnections.orgId, orgId),
              eq(userIntegrationConnections.userId, userId),
            ),
          )
          .orderBy(desc(userIntegrationConnections.createdAt))
          .limit(1);
        const nextRow = next[0];
        if (nextRow) {
          await tx
            .update(userIntegrationConnections)
            .set({ isPrimary: true })
            .where(eq(userIntegrationConnections.id, nextRow.id));
        }
      }
    });
    try {
      await this.gateway.deleteConnectedAccount(row.composioConnectedAccountId);
    } catch (error) {
      this.logger.warn(
        `Failed to delete Composio account ${row.composioConnectedAccountId}: ${String(error)}`,
      );
    }
    return { deleted: true };
  }

  async setPrimary(orgId: string, userId: string, connectionId: number) {
    await this.ownedConnection(orgId, userId, connectionId);
    return this.db.transaction(async (tx) => {
      await tx
        .update(userIntegrationConnections)
        .set({ isPrimary: false })
        .where(
          and(
            eq(userIntegrationConnections.orgId, orgId),
            eq(userIntegrationConnections.userId, userId),
          ),
        );
      const rows = await tx
        .update(userIntegrationConnections)
        .set({ isPrimary: true })
        .where(
          and(
            eq(userIntegrationConnections.id, connectionId),
            eq(userIntegrationConnections.orgId, orgId),
            eq(userIntegrationConnections.userId, userId),
          ),
        )
        .returning(CONNECTION_COLUMNS);
      const row = rows[0];
      if (!row) throw new NotFoundException("Connection not found");
      return row;
    });
  }

  private toToolkit(slug: string | null): IntegrationToolkit {
    if (slug === "googlecalendar" || slug === "outlook" || slug === "gmail") return slug;
    throw new BadRequestException(`Unsupported toolkit: ${slug ?? "unknown"}`);
  }

  async ownedConnection(orgId: string, userId: string, connectionId: number) {
    const rows = await this.db
      .select(OWNED_CONNECTION_COLUMNS)
      .from(userIntegrationConnections)
      .where(
        and(
          eq(userIntegrationConnections.id, connectionId),
          eq(userIntegrationConnections.orgId, orgId),
          eq(userIntegrationConnections.userId, userId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("Connection not found");
    return row;
  }
}
