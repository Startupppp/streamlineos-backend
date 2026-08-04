import { Inject, Injectable } from "@nestjs/common";
import { and, eq, lt } from "drizzle-orm";
import { invitations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";

@Injectable()
export class CronOrganizationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async expireStaleInvitations(): Promise<{ expired: number }> {
    const now = new Date();
    let expired = 0;

    await forEachOrg(this.db, "org-expire-invitations", async (tx, orgId) => {
      const result = await tx
        .update(invitations)
        .set({ status: "EXPIRED" })
        .where(
          and(
            eq(invitations.orgId, orgId),
            eq(invitations.status, "PENDING"),
            lt(invitations.expiresAt, now),
          ),
        )
        .returning({ id: invitations.id });
      expired += result.length;
    });

    return { expired };
  }
}
