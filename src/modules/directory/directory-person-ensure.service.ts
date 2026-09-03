import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNotNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { organizationPeople } from "../../db/schema";
import { isUniqueViolation } from "../../common/db/postgres-error";
import {
  assertCompatibleLink,
  findMemberIdentity,
  findPersonForIdentity,
  normalizeEmail,
} from "./directory-identity-helpers";
import { DirectoryIdentityService } from "./directory-identity.service";

@Injectable()
export class DirectoryPersonEnsureService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly identities: DirectoryIdentityService,
  ) {}

  async ensurePersonForMember(
    organizationId: string,
    memberUserId: string,
  ): Promise<typeof organizationPeople.$inferSelect> {
    const identity = await findMemberIdentity(this.db, organizationId, {
      memberUserId,
    });
    if (!identity) {
      throw new NotFoundException(
        "This member is no longer available in the organization.",
      );
    }

    const existing = await findPersonForIdentity(this.db, organizationId, identity);
    if (existing) {
      assertCompatibleLink(existing, identity);
      return this.identities.reconcilePersonIdentity(organizationId, existing);
    }

    const deleted = await findPersonForIdentity(
      this.db,
      organizationId,
      identity,
      "deleted",
    );
    if (deleted) {
      assertCompatibleLink(deleted, identity);
      try {
        const [restored] = await this.db
          .update(organizationPeople)
          .set({
            deletedAt: null,
            userId: identity.userId,
            organizationMembershipId: identity.membershipId,
          })
          .where(
            and(
              eq(
                organizationPeople.organizationPersonId,
                deleted.organizationPersonId,
              ),
              eq(organizationPeople.organizationId, organizationId),
              isNotNull(organizationPeople.deletedAt),
            ),
          )
          .returning();
        if (restored) return restored;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw new ConflictException({
          code: "DIRECTORY_MEMBER_ALREADY_LINKED",
          message:
            "This member is already linked to another directory person record. Refresh and select that person instead.",
        });
      }
    }

    const fullNameParts =
      identity.name?.trim().split(/\s+/).filter(Boolean) ?? [];
    const firstName =
      identity.firstName?.trim() ||
      fullNameParts[0] ||
      identity.email.split("@")[0] ||
      "Member";
    const lastName =
      identity.lastName?.trim() || fullNameParts.slice(1).join(" ") || "";

    try {
      const [created] = await this.db
        .insert(organizationPeople)
        .values({
          organizationId,
          userId: identity.userId,
          organizationMembershipId: identity.membershipId,
          firstName,
          lastName,
          displayName: identity.name?.trim() || null,
          workEmail: normalizeEmail(identity.email),
          phone: identity.phone,
        })
        .returning();
      if (!created)
        throw new NotFoundException("Failed to create person record");
      return created;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await findPersonForIdentity(this.db, organizationId, identity);
      if (winner) {
        assertCompatibleLink(winner, identity);
        return this.identities.reconcilePersonIdentity(organizationId, winner);
      }
      throw new ConflictException({
        code: "DIRECTORY_MEMBER_ALREADY_LINKED",
        message:
          "A directory person already uses this member or work email. Refresh and select that person instead.",
      });
    }
  }
}
