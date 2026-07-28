import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { organizationMembers, organizations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import type { TransferOwnershipInput } from "./dto/organization.schemas";

@Injectable()
export class OrgOwnershipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async transferOwnership(
    orgId: string,
    currentOwnerId: string,
    input: TransferOwnershipInput,
  ) {
    if (input.newOwnerUserId === currentOwnerId) {
      throw new BadRequestException("You are already the owner");
    }

    const result = await this.db.transaction(async (tx) => {
      const [org] = await tx
        .select({ ownerMembershipId: organizations.ownerMembershipId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .for("update");
      if (!org) throw new NotFoundException("Organization not found");

      const members = await tx
        .select({
          id: organizationMembers.id,
          userId: organizationMembers.userId,
          isOwner: organizationMembers.isOwner,
          status: organizationMembers.status,
        })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            inArray(organizationMembers.userId, [
              currentOwnerId,
              input.newOwnerUserId,
            ]),
          ),
        )
        .for("update");

      const currentMember = members.find((m) => m.userId === currentOwnerId);
      const targetMember = members.find(
        (m) => m.userId === input.newOwnerUserId,
      );

      if (!currentMember) {
        throw new BadRequestException(
          "You are not a member of this organization",
        );
      }
      const isCurrentOwner =
        currentMember.isOwner ||
        (org.ownerMembershipId != null &&
          org.ownerMembershipId === currentMember.id);
      if (!isCurrentOwner) {
        throw new ForbiddenException(
          "Only the current owner can transfer ownership",
        );
      }
      if (!targetMember) {
        throw new BadRequestException(
          "New owner must be an existing org member",
        );
      }
      if (targetMember.status !== "ACTIVE") {
        throw new BadRequestException("New owner must be an active member");
      }

      await tx
        .update(organizationMembers)
        .set({ isOwner: false, role: "ADMIN" })
        .where(eq(organizationMembers.id, currentMember.id));
      await tx
        .update(organizationMembers)
        .set({ isOwner: true, role: "OWNER", status: "ACTIVE" })
        .where(eq(organizationMembers.id, targetMember.id));
      await tx
        .update(organizations)
        .set({ ownerMembershipId: targetMember.id })
        .where(eq(organizations.id, orgId));

      await bumpPermissionsVersion(tx, orgId);
      return { from: currentMember.userId, to: targetMember.userId };
    });

    await this.cache.invalidate(CACHE_KEYS.userSession(currentOwnerId));
    await this.cache.invalidate(CACHE_KEYS.userSession(input.newOwnerUserId));
    this.audit.log({
      action: "org.ownership_transferred",
      userId: currentOwnerId,
      orgId,
      targetId: input.newOwnerUserId,
      targetType: "user",
      metadata: { from: result.from, to: result.to },
    });

    return { success: true };
  }
}
