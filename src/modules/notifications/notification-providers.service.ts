import { Inject, Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { and, eq, desc } from "drizzle-orm";
import { notificationProviderAccounts, notificationAuditLogs, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { encryptSecret } from "../../common/security/secret-encryption.util";
import { CacheService } from "../../common/cache/cache.service";
import { NOTIF_CACHE } from "./notification-cache-keys";
import { NotificationProviderRegistry } from "./providers/notification-provider-registry.service";
import type { CreateProviderInput, UpdateProviderInput, TestProviderInput } from "./dto/provider.schemas";

type ProviderRow = typeof notificationProviderAccounts.$inferSelect;

@Injectable()
export class NotificationProvidersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly registry: NotificationProviderRegistry,
  ) {}

  private sanitize(row: ProviderRow) {
    const { configEncrypted, ...rest } = row;
    return { ...rest, hasCredentials: Boolean(configEncrypted) };
  }

  private async audit(orgId: string, actorId: string, action: string, id: number, channel: string) {
    await this.db.insert(notificationAuditLogs).values({
      orgId,
      actorId,
      action,
      channel,
      metadata: { entityType: "provider", providerId: id },
    });
  }

  async list(orgId: string) {
    const rows = await this.db.query.notificationProviderAccounts.findMany({
      where: eq(notificationProviderAccounts.orgId, orgId),
      orderBy: [desc(notificationProviderAccounts.createdAt)],
      limit: 100,
    });
    return rows.map((r) => this.sanitize(r));
  }

  private encryptConfig(config: Record<string, unknown> | undefined): string | null {
    if (!config || Object.keys(config).length === 0) return null;
    try {
      return encryptSecret(JSON.stringify(config));
    } catch {
      throw new BadRequestException("ENCRYPTION_KEY is not configured — cannot store provider credentials");
    }
  }

  async create(orgId: string, userId: string, dto: CreateProviderInput) {
    const [row] = await this.db
      .insert(notificationProviderAccounts)
      .values({
        orgId,
        channel: dto.channel,
        provider: dto.provider,
        displayName: dto.displayName,
        configEncrypted: this.encryptConfig(dto.config),
        enabled: dto.enabled ?? true,
        sandboxMode: dto.sandboxMode ?? true,
        isDefault: dto.isDefault ?? false,
        dailySendLimit: dto.dailySendLimit ?? null,
        monthlyCostLimit: dto.monthlyCostLimit ?? null,
        createdBy: userId,
      })
      .returning();
    if (!row) throw new BadRequestException("Failed to create provider");
    await this.audit(orgId, userId, "provider.created", row.id, dto.channel);
    await this.cache.del(NOTIF_CACHE.availability(orgId));
    return this.sanitize(row);
  }

  async update(orgId: string, userId: string, id: number, dto: UpdateProviderInput) {
    const existing = await this.db.query.notificationProviderAccounts.findFirst({
      where: and(eq(notificationProviderAccounts.id, id), eq(notificationProviderAccounts.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Provider not found");

    const [row] = await this.db
      .update(notificationProviderAccounts)
      .set({
        ...(dto.displayName !== undefined && { displayName: dto.displayName }),
        ...(dto.config !== undefined && { configEncrypted: this.encryptConfig(dto.config) }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.sandboxMode !== undefined && { sandboxMode: dto.sandboxMode }),
        ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
        ...(dto.dailySendLimit !== undefined && { dailySendLimit: dto.dailySendLimit }),
        ...(dto.monthlyCostLimit !== undefined && { monthlyCostLimit: dto.monthlyCostLimit }),
      })
      .where(eq(notificationProviderAccounts.id, id))
      .returning();
    if (!row) throw new NotFoundException("Provider not found");
    await this.audit(orgId, userId, "provider.updated", row.id, row.channel);
    await this.cache.del(NOTIF_CACHE.availability(orgId));
    return this.sanitize(row);
  }

  async remove(orgId: string, userId: string, id: number) {
    const existing = await this.db.query.notificationProviderAccounts.findFirst({
      where: and(eq(notificationProviderAccounts.id, id), eq(notificationProviderAccounts.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Provider not found");
    await this.db.delete(notificationProviderAccounts).where(eq(notificationProviderAccounts.id, id));
    await this.audit(orgId, userId, "provider.deleted", id, existing.channel);
    await this.cache.del(NOTIF_CACHE.availability(orgId));
    return { success: true };
  }

  async test(orgId: string, userId: string, id: number, dto: TestProviderInput) {
    const account = await this.db.query.notificationProviderAccounts.findFirst({
      where: and(eq(notificationProviderAccounts.id, id), eq(notificationProviderAccounts.orgId, orgId)),
    });
    if (!account) throw new NotFoundException("Provider not found");

    const channel = account.channel;
    const provider = this.registry.get(channel);
    if (!provider) throw new BadRequestException(`No provider implementation for ${channel}`);

    let recipient = dto.to ?? null;
    if (!recipient && channel === "EMAIL") {
      const me = await this.db.query.users.findFirst({ where: eq(users.id, userId), columns: { email: true } });
      recipient = me?.email ?? null;
    }

    const result = await provider.sendTest({
      orgId,
      userId,
      channel,
      recipientAddress: recipient,
      title: "StreamlineOS test notification",
      message: "This is a test message confirming your notification provider is configured correctly.",
      link: null,
      priority: "NORMAL",
      sandbox: account.sandboxMode,
    });

    await this.db
      .update(notificationProviderAccounts)
      .set({ lastTestedAt: new Date(), healthStatus: result.status === "SENT" ? "healthy" : "unhealthy" })
      .where(eq(notificationProviderAccounts.id, id));
    await this.audit(orgId, userId, "provider.tested", id, channel);

    return { status: result.status, sandbox: account.sandboxMode, message: result.failureMessage ?? "Test dispatched", providerMessageId: result.providerMessageId ?? null };
  }
}
