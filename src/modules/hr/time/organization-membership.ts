import { ForbiddenException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";

/** Resolves a current tenant actor once, before it is used as a row authority key. */
export async function requireOrganizationMembershipId(
  db: Db,
  orgId: string,
  userId: string,
): Promise<number> {
  try {
    return (await assertOrganizationActor(db, orgId, { kind: "user", userId })).membershipId;
  } catch (error) {
    if (error instanceof OrganizationActorError) throw organizationActorHttpError(error);
    if (error instanceof ForbiddenException) throw error;
    throw error;
  }
}
