import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  organizationMembers,
  organizations,
  platformPayments,
  subscriptions,
  users,
} from "../../db/schema";

@Injectable()
export class PlatformOperatorCustomerService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getCustomer(orgId: string) {
    return runInTenantTransaction(this.db, async (tx) => {
      const [organization] = await tx
        .select({
          id: organizations.id,
          slug: organizations.slug,
          name: organizations.name,
          status: organizations.status,
          createdAt: organizations.createdAt,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (!organization) throw new NotFoundException("Customer not found");

      const members = await tx
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: organizationMembers.role,
          joinedAt: organizationMembers.joinedAt,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(eq(organizationMembers.orgId, orgId))
        .orderBy(desc(organizationMembers.joinedAt))
        .limit(50);

      return { organization, members };
    });
  }

  async getBilling(orgId: string) {
    return runInTenantTransaction(this.db, async (tx) => {
      const [subscription, payments] = await Promise.all([
        tx
          .select({
            id: subscriptions.id,
            plan: subscriptions.plan,
            status: subscriptions.status,
            currentPeriodStart: subscriptions.currentPeriodStart,
            currentPeriodEnd: subscriptions.currentPeriodEnd,
            trialEndsAt: subscriptions.trialEndsAt,
            cancelledAt: subscriptions.cancelledAt,
          })
          .from(subscriptions)
          .where(eq(subscriptions.orgId, orgId))
          .orderBy(desc(subscriptions.id))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        tx
          .select({
            id: platformPayments.id,
            amount: platformPayments.amount,
            currency: platformPayments.currency,
            status: platformPayments.status,
            method: platformPayments.method,
            description: platformPayments.description,
            capturedAt: platformPayments.capturedAt,
            refundedAt: platformPayments.refundedAt,
            createdAt: platformPayments.createdAt,
          })
          .from(platformPayments)
          .where(eq(platformPayments.orgId, orgId))
          .orderBy(desc(platformPayments.createdAt))
          .limit(100),
      ]);

      return { subscription, payments };
    });
  }
}
