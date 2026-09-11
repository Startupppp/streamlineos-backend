import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  userIntegrationConnections,
  type IntegrationToolkit,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { isStructuralOrgAdmin } from "../../../common/rbac/is-structural-org-admin";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { ComposioGateway } from "./composio.gateway";
import { orgComposioUserId } from "./connection-resolution";
import { CONNECTION_COLUMNS, type ConnectionRow } from "./connection-columns";
import {
  defaultReturnPath,
  toIntegrationToolkit,
  type ConnectionReturnPath,
} from "./connection-toolkit";

@Injectable()
export class OrgConnectionsService {
  private readonly logger = new Logger(OrgConnectionsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly gateway: ComposioGateway,
  ) {}

  private orgScoped(orgId: string) {
    return and(
      eq(userIntegrationConnections.orgId, orgId),
      eq(userIntegrationConnections.scope, "org"),
    );
  }

  private async assertOrgAdmin(actor: CurrentUserContext): Promise<void> {
    if (await isStructuralOrgAdmin(this.db, actor)) return;
    throw new ForbiddenException(
      "Only an organization owner or admin may manage organization-wide connections",
    );
  }

  async list(actor: CurrentUserContext): Promise<ConnectionRow[]> {
    await this.assertOrgAdmin(actor);
    return this.db
      .select(CONNECTION_COLUMNS)
      .from(userIntegrationConnections)
      .where(this.orgScoped(actor.orgId))
      .orderBy(desc(userIntegrationConnections.createdAt))
      .limit(50);
  }

  async initiate(
    actor: CurrentUserContext,
    toolkit: IntegrationToolkit,
    returnPath?: ConnectionReturnPath,
  ): Promise<{ redirectUrl: string }> {
    await this.assertOrgAdmin(actor);
    const callbackUrl = `${this.config.APP_URL}${returnPath ?? defaultReturnPath(toolkit)}`;
    return this.gateway.initiateConnection(
      orgComposioUserId(actor.orgId),
      toolkit,
      callbackUrl,
    );
  }

  async finalize(
    actor: CurrentUserContext,
    connectedAccountId: string,
  ): Promise<ConnectionRow> {
    await this.assertOrgAdmin(actor);
    const principal = orgComposioUserId(actor.orgId);
    const account = await this.gateway.getOwnedConnectedAccount(
      principal,
      connectedAccountId,
    );
    if (!account) {
      throw new ForbiddenException(
        "Connected account does not belong to this organization",
      );
    }
    if (account.status.toUpperCase() !== "ACTIVE") {
      throw new BadRequestException(
        "Connection is not active yet. Complete the authorization and try again.",
      );
    }
    const toolkit = toIntegrationToolkit(account.toolkitSlug);
    const email =
      (await this.gateway.getAccountEmail(principal, account.id, toolkit)) ??
      account.email;
    const { row, superseded } = await this.replace(
      actor.orgId,
      principal,
      toolkit,
      account.id,
      email,
    );
    for (const staleId of superseded) await this.forgetAtComposio(staleId);
    return row;
  }

  async disconnect(
    actor: CurrentUserContext,
    connectionId: number,
  ): Promise<{ deleted: true }> {
    await this.assertOrgAdmin(actor);
    const removed = await this.db
      .delete(userIntegrationConnections)
      .where(
        and(
          eq(userIntegrationConnections.id, connectionId),
          this.orgScoped(actor.orgId),
        ),
      )
      .returning({
        composioConnectedAccountId:
          userIntegrationConnections.composioConnectedAccountId,
      });
    const row = removed[0];
    if (!row) throw new NotFoundException("Connection not found");
    await this.forgetAtComposio(row.composioConnectedAccountId);
    return { deleted: true };
  }

  private async replace(
    orgId: string,
    composioUserId: string,
    toolkit: IntegrationToolkit,
    connectedAccountId: string,
    email: string | null,
  ): Promise<{ row: ConnectionRow; superseded: string[] }> {
    try {
      return await this.db.transaction(async (tx) => {
        const dropped = await tx
          .delete(userIntegrationConnections)
          .where(
            and(
              this.orgScoped(orgId),
              eq(userIntegrationConnections.toolkit, toolkit),
              ne(
                userIntegrationConnections.composioConnectedAccountId,
                connectedAccountId,
              ),
            ),
          )
          .returning({
            composioConnectedAccountId:
              userIntegrationConnections.composioConnectedAccountId,
          });
        const rows = await tx
          .insert(userIntegrationConnections)
          .values({
            orgId,
            userId: composioUserId,
            membershipId: null,
            toolkit,
            composioConnectedAccountId: connectedAccountId,
            accountEmail: email,
            accountLabel: email,
            status: "active",
            isPrimary: true,
            scope: "org",
          })
          .onConflictDoUpdate({
            target: userIntegrationConnections.composioConnectedAccountId,
            set: {
              status: "active",
              accountEmail: email,
              accountLabel: email,
              updatedAt: new Date(),
            },
            setWhere: this.orgScoped(orgId),
          })
          .returning(CONNECTION_COLUMNS);
        const row = rows[0];
        if (!row) {
          throw new ConflictException(
            "That connected account is already registered to another connection",
          );
        }
        return {
          row,
          superseded: dropped.map((entry) => entry.composioConnectedAccountId),
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          "An organization connection for this toolkit already exists",
        );
      }
      throw error;
    }
  }

  private async forgetAtComposio(connectedAccountId: string): Promise<void> {
    try {
      await this.gateway.deleteConnectedAccount(connectedAccountId);
    } catch (error) {
      this.logger.warn(
        `Failed to delete Composio account ${connectedAccountId}: ${String(error)}`,
      );
    }
  }
}
