import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { hrAccessRequests } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateAccessRequestInput, PatchAccessRequestInput } from "./dto/hr-directory.schemas";

@Injectable()
export class AccessRequestsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string, employeeId?: string) {
    return this.db
      .select()
      .from(hrAccessRequests)
      .where(
        and(
          eq(hrAccessRequests.orgId, orgId),
          employeeId ? eq(hrAccessRequests.employeeId, employeeId) : undefined,
        ),
      )
      .orderBy(desc(hrAccessRequests.createdAt))
      .limit(200);
  }

  async create(orgId: string, input: CreateAccessRequestInput) {
    const [record] = await this.db
      .insert(hrAccessRequests)
      .values({
        orgId,
        employeeId: input.employeeId,
        systemName: input.systemName,
        accessLevel: input.accessLevel,
        status: "requested",
      })
      .returning();
    return record;
  }

  async update(orgId: string, id: string, input: PatchAccessRequestInput, actorUserId: string) {
    const existing = await this.db.query.hrAccessRequests.findFirst({
      where: and(eq(hrAccessRequests.id, id), eq(hrAccessRequests.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Access request not found.");

    const updateValues: Partial<typeof hrAccessRequests.$inferInsert> = {
      status: input.status,
      updatedAt: new Date(),
    };

    if (input.status === "granted") {
      updateValues.grantedBy = input.grantedBy ?? actorUserId;
    } else if (input.status === "revoked") {
      updateValues.revokedAt = new Date();
    }

    const [updated] = await this.db
      .update(hrAccessRequests)
      .set(updateValues)
      .where(and(eq(hrAccessRequests.id, id), eq(hrAccessRequests.orgId, orgId)))
      .returning();

    return updated;
  }
}
