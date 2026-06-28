import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { serviceAccounts, apiKeys } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import type {
  CreateServiceAccountInput,
  UpdateServiceAccountInput,
  ListServiceAccountsQuery,
} from "./dto/service-accounts.schemas";

@Injectable()
export class ServiceAccountsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, query: ListServiceAccountsQuery) {
    const offset = (query.page - 1) * query.limit;
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(serviceAccounts)
        .where(eq(serviceAccounts.orgId, orgId))
        .orderBy(desc(serviceAccounts.createdAt))
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(serviceAccounts)
        .where(eq(serviceAccounts.orgId, orgId)),
    ]);
    return { data: rows, meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
  }

  async create(orgId: string, userId: string, input: CreateServiceAccountInput) {
    const id = randomUUID();
    const [row] = await this.db
      .insert(serviceAccounts)
      .values({ id, orgId, name: input.name, description: input.description, permissions: input.permissions, createdBy: userId })
      .returning();

    this.audit.log({ action: "service_account.created", userId, orgId, targetId: id, targetType: "service_account", metadata: { name: input.name } });

    const { apiKey, keyPrefix, keyHash } = this.generateApiKey();
    const keyId = randomUUID();
    await this.db.insert(apiKeys).values({
      id: keyId,
      orgId,
      name: `${input.name} — default key`,
      keyPrefix,
      keyHash,
      scopes: input.permissions,
      createdBy: userId,
    });

    return { serviceAccount: row, apiKey };
  }

  async update(orgId: string, userId: string, serviceAccountId: string, input: UpdateServiceAccountInput) {
    const existing = await this.db.query.serviceAccounts.findFirst({
      where: and(eq(serviceAccounts.id, serviceAccountId), eq(serviceAccounts.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Service account not found");

    const [updated] = await this.db
      .update(serviceAccounts)
      .set({ ...(input.name !== undefined && { name: input.name }), ...(input.description !== undefined && { description: input.description }), ...(input.permissions !== undefined && { permissions: input.permissions }), ...(input.isActive !== undefined && { isActive: input.isActive }) })
      .where(eq(serviceAccounts.id, serviceAccountId))
      .returning();

    this.audit.log({ action: "service_account.updated", userId, orgId, targetId: serviceAccountId, targetType: "service_account" });
    return updated;
  }

  async remove(orgId: string, userId: string, serviceAccountId: string) {
    const existing = await this.db.query.serviceAccounts.findFirst({
      where: and(eq(serviceAccounts.id, serviceAccountId), eq(serviceAccounts.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Service account not found");

    await this.db.delete(serviceAccounts).where(eq(serviceAccounts.id, serviceAccountId));
    this.audit.log({ action: "service_account.deleted", userId, orgId, targetId: serviceAccountId, targetType: "service_account" });
    return { success: true };
  }

  async rotateKey(orgId: string, userId: string, serviceAccountId: string) {
    const existing = await this.db.query.serviceAccounts.findFirst({
      where: and(eq(serviceAccounts.id, serviceAccountId), eq(serviceAccounts.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Service account not found");

    const { apiKey, keyPrefix, keyHash } = this.generateApiKey();
    const keyId = randomUUID();
    await this.db.insert(apiKeys).values({
      id: keyId,
      orgId,
      name: `${existing.name} — rotated key`,
      keyPrefix,
      keyHash,
      scopes: existing.permissions,
      createdBy: userId,
    });

    this.audit.log({ action: "service_account.key_rotated", userId, orgId, targetId: serviceAccountId, targetType: "service_account" });
    return { apiKey, keyId };
  }

  private generateApiKey() {
    const rawKey = randomBytes(32).toString("hex");
    const apiKey = `sk_live_${rawKey}`;
    const keyPrefix = apiKey.substring(0, 12);
    const keyHash = createHash("sha256").update(apiKey).digest("hex");
    return { apiKey, keyPrefix, keyHash };
  }
}
