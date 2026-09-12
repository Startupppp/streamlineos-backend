import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, ilike, isNull, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  invUserWarehouses,
  invWarehouses,
  organizationMembers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type {
  ListAssignableUsersInput,
  ListWarehouseUsersInput,
} from "./dto/inv-warehouses.schemas";

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (c) => `\\${c}`);
}

export interface WarehouseAssignee {
  userId: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
  image: string | null;
  grantedBy: string;
  grantedByName: string | null;
  grantedAt: Date;
}

export interface WarehouseAssigneePage {
  items: WarehouseAssignee[];
  total: number;
  page: number;
  totalPages: number;
}

export interface AssignableUser {
  userId: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
  image: string | null;
}

/**
 * A7. Who may transact in a warehouse.
 *
 * `WarehouseScopeService` reads `inv_user_warehouses` on every scoped query; this
 * is the only writer. Deny-by-default means an unassigned operator sees nothing,
 * so granting and revoking is a privileged, audited act in its own right rather
 * than a side effect of editing a warehouse.
 */
@Injectable()
export class WarehouseAssignmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
  ) {}

  /**
   * Re-assert the warehouse inside the caller's tenant. A miss is 404 rather
   * than 403 so another org's id cannot be probed for existence.
   */
  private async assertWarehouse(orgId: string, warehouseId: number): Promise<void> {
    const warehouse = await this.db.query.invWarehouses.findFirst({
      where: and(eq(invWarehouses.id, warehouseId), eq(invWarehouses.orgId, orgId)),
      columns: { id: true },
    });
    if (!warehouse) throw new NotFoundException("Warehouse not found");
  }

  /** The grantee has to be a live member of this org, or the grant is cross-tenant. */
  private async assertOrgMember(orgId: string, userId: string): Promise<void> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!member) throw new NotFoundException("User not found in this organization");
  }

  async listAssignedUsers(
    orgId: string,
    warehouseId: number,
    filters: ListWarehouseUsersInput,
  ): Promise<WarehouseAssigneePage> {
    await this.assertWarehouse(orgId, warehouseId);

    const scope = and(
      eq(invUserWarehouses.orgId, orgId),
      eq(invUserWarehouses.warehouseId, warehouseId),
    );
    const granter = alias(users, "granter");
    const offset = (filters.page - 1) * filters.limit;

    const [items, totals] = await Promise.all([
      this.db
        .select({
          userId: invUserWarehouses.userId,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          image: users.image,
          grantedBy: invUserWarehouses.grantedBy,
          grantedByName: granter.name,
          grantedAt: invUserWarehouses.createdAt,
        })
        .from(invUserWarehouses)
        .innerJoin(users, eq(users.id, invUserWarehouses.userId))
        .leftJoin(granter, eq(granter.id, invUserWarehouses.grantedBy))
        .where(scope)
        .orderBy(asc(users.email))
        .limit(filters.limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invUserWarehouses)
        .where(scope),
    ]);

    const total = totals[0]?.count ?? 0;
    return {
      items,
      total,
      page: filters.page,
      totalPages: Math.max(1, Math.ceil(total / filters.limit)),
    };
  }

  /**
   * Live org members who do not already hold this warehouse. Bounded and
   * org-scoped: it is a picker feed, not a directory export.
   */
  async listAssignableUsers(
    orgId: string,
    warehouseId: number,
    filters: ListAssignableUsersInput,
  ): Promise<AssignableUser[]> {
    await this.assertWarehouse(orgId, warehouseId);

    const conds = [
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.status, "ACTIVE"),
      isNull(users.deletedAt),
      notExists(
        this.db
          .select({ one: sql`1` })
          .from(invUserWarehouses)
          .where(
            and(
              eq(invUserWarehouses.orgId, orgId),
              eq(invUserWarehouses.warehouseId, warehouseId),
              eq(invUserWarehouses.userId, organizationMembers.userId),
            ),
          ),
      ),
    ];

    if (filters.q) {
      const term = `%${escapeLike(filters.q)}%`;
      conds.push(or(ilike(users.name, term), ilike(users.email, term))!);
    }

    return this.db
      .select({
        userId: organizationMembers.userId,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        image: users.image,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(...conds))
      .orderBy(asc(users.email))
      .limit(filters.limit);
  }

  /**
   * Idempotent by the `(org_id, user_id, warehouse_id)` unique index: a repeated
   * grant is the same state, so it neither errors nor writes a second audit row.
   */
  async grant(
    orgId: string,
    actorUserId: string,
    warehouseId: number,
    userId: string,
  ): Promise<{ granted: boolean }> {
    await this.assertWarehouse(orgId, warehouseId);
    await this.assertOrgMember(orgId, userId);

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(invUserWarehouses)
        .values({ orgId, userId, warehouseId, grantedBy: actorUserId })
        .onConflictDoNothing({
          target: [
            invUserWarehouses.orgId,
            invUserWarehouses.userId,
            invUserWarehouses.warehouseId,
          ],
        })
        .returning({ userId: invUserWarehouses.userId });

      if (inserted.length === 0) return { granted: false };

      await this.audit.insert(tx, {
        orgId,
        actorUserId,
        action: "warehouse.scope.granted",
        resourceType: "warehouse",
        resourceId: String(warehouseId),
        after: { userId, warehouseId },
      });

      return { granted: true };
    });
  }

  async revoke(
    orgId: string,
    actorUserId: string,
    warehouseId: number,
    userId: string,
  ): Promise<{ revoked: true }> {
    await this.assertWarehouse(orgId, warehouseId);

    return this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(invUserWarehouses)
        .where(
          and(
            eq(invUserWarehouses.orgId, orgId),
            eq(invUserWarehouses.warehouseId, warehouseId),
            eq(invUserWarehouses.userId, userId),
          ),
        )
        .returning({ userId: invUserWarehouses.userId });

      if (deleted.length === 0) throw new NotFoundException("Assignment not found");

      await this.audit.insert(tx, {
        orgId,
        actorUserId,
        action: "warehouse.scope.revoked",
        resourceType: "warehouse",
        resourceId: String(warehouseId),
        before: { userId, warehouseId },
      });

      return { revoked: true };
    });
  }
}
