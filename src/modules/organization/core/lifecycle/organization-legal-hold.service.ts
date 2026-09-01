import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.types";
import { organizationLegalHolds, organizations } from "../../../../db/schema";
import { AuditService } from "../../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { assertTransitionAllowed } from "./organization-lifecycle-transitions";
import { OrganizationSagaService } from "./organization-saga.service";

@Injectable()
export class OrganizationLegalHoldService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly saga: OrganizationSagaService,
  ) {}

  async place(orgId: string, actorUserId: string, reason: string) {
    const preflight = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [org] = await tx
          .select({ statusV2: organizations.statusV2 })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1);
        if (!org) return null;

        const [existingHold] = await tx
          .select({ holdId: organizationLegalHolds.holdId })
          .from(organizationLegalHolds)
          .where(
            and(
              eq(organizationLegalHolds.orgId, orgId),
              isNull(organizationLegalHolds.releasedAt),
            ),
          )
          .limit(1);

        return { statusV2: org.statusV2, hasExistingHold: existingHold !== undefined };
      },
      { orgId },
    );
    if (!preflight) throw new NotFoundException("Organization not found");
    if (preflight.hasExistingHold)
      throw new ConflictException(
        "An active legal hold already exists for this organization",
      );

    const transition = assertTransitionAllowed(
      "LEGAL_HOLD",
      preflight.statusV2 ?? "ACTIVE",
      { hasActiveLegalHold: false },
    );
    if (!transition.allowed) throw new BadRequestException(transition.reason);

    const sagaCtx = await this.saga.begin(
      "LEGAL_HOLD",
      orgId,
      randomUUID(),
      actorUserId,
      preflight.statusV2 ?? "ACTIVE",
    );

    await this.saga.runStep(sagaCtx.saga.sagaId, "record-legal-hold", () =>
      runInTenantTransaction(
        this.db,
        (tx) =>
          tx.insert(organizationLegalHolds).values({
            orgId,
            reason,
            placedBy: actorUserId,
            placedAt: new Date(),
          }),
        { orgId },
      ),
    );

    await this.saga.complete(sagaCtx.saga.sagaId);

    this.audit.log({
      action: "org.legal_hold_placed",
      userId: actorUserId,
      orgId,
      targetId: orgId,
      targetType: "organization",
      metadata: { reason },
    });

    return { success: true as const };
  }

  async release(holdId: string, orgId: string, actorUserId: string) {
    const preflight = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [org] = await tx
          .select({ statusV2: organizations.statusV2 })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1);
        if (!org) return null;
        return { statusV2: org.statusV2 };
      },
      { orgId },
    );
    if (!preflight) throw new NotFoundException("Organization not found");

    const transition = assertTransitionAllowed(
      "LEGAL_HOLD_RELEASE",
      preflight.statusV2 ?? "ACTIVE",
      { hasActiveLegalHold: true },
    );
    if (!transition.allowed) throw new BadRequestException(transition.reason);

    const sagaCtx = await this.saga.begin(
      "LEGAL_HOLD_RELEASE",
      orgId,
      randomUUID(),
      actorUserId,
      preflight.statusV2 ?? "ACTIVE",
    );

    await this.saga.runStep(sagaCtx.saga.sagaId, "validate-hold-exists", () =>
      Promise.resolve(),
    );

    await this.saga.runStep(sagaCtx.saga.sagaId, "release-legal-hold", async () => {
      const updated = await runInTenantTransaction(
        this.db,
        (tx) =>
          tx
            .update(organizationLegalHolds)
            .set({ releasedBy: actorUserId, releasedAt: new Date() })
            .where(
              and(
                eq(organizationLegalHolds.holdId, holdId),
                eq(organizationLegalHolds.orgId, orgId),
                isNull(organizationLegalHolds.releasedAt),
              ),
            )
            .returning({ holdId: organizationLegalHolds.holdId }),
        { orgId },
      );
      if (updated.length === 0)
        throw new NotFoundException("Hold not found or already released");
    });

    await this.saga.complete(sagaCtx.saga.sagaId);

    this.audit.log({
      action: "org.legal_hold_released",
      userId: actorUserId,
      orgId,
      targetId: holdId,
      targetType: "organization_legal_hold",
    });

    return { success: true as const };
  }

  async listActive(orgId: string) {
    return runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .select({
            holdId: organizationLegalHolds.holdId,
            orgId: organizationLegalHolds.orgId,
            reason: organizationLegalHolds.reason,
            placedBy: organizationLegalHolds.placedBy,
            placedAt: organizationLegalHolds.placedAt,
          })
          .from(organizationLegalHolds)
          .where(
            and(
              eq(organizationLegalHolds.orgId, orgId),
              isNull(organizationLegalHolds.releasedAt),
            ),
          )
          .limit(1),
      { orgId },
    );
  }
}
