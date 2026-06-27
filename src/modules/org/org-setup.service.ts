import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { organizations, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { type SetupInput } from "./dto/org.schemas";

@Injectable()
export class OrgSetupService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async completeSetup(u: CurrentUserContext, input: SetupInput) {
    if (!u.isOrgOwner) {
      throw new ForbiddenException("Forbidden");
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(organizations)
        .set({
          name: input.companyName,
          industry: input.industry,
          companySize: input.companySize,
          country: input.country,
          onboardingCompletedAt: new Date(),
        })
        .where(eq(organizations.id, u.orgId));

      await tx
        .update(users)
        .set({
          firstName: input.firstName,
          lastName: input.lastName,
          name: `${input.firstName} ${input.lastName}`,
          designation: input.jobTitle,
          ...(input.phone ? { phone: input.phone } : {}),
        })
        .where(eq(users.id, u.userId));
    });

    return { success: true };
  }
}
