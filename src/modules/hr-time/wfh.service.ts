import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { users, wfhRequests } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { formatDateOnly } from "./date.helpers";
import type { CreateWfhInput, UpdateWfhInput } from "./dto/wfh.schemas";

@Injectable()
export class WfhService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string, userId: string) {
    return this.db.query.wfhRequests.findMany({
      where: and(eq(wfhRequests.orgId, orgId), eq(wfhRequests.userId, userId)),
      orderBy: [desc(wfhRequests.createdAt)],
      limit: 100,
    });
  }

  async create(orgId: string, userId: string, body: CreateWfhInput) {
    await this.db
      .insert(wfhRequests)
      .values({
        orgId,
        userId,
        date: formatDateOnly(body.date),
        reason: body.reason,
        approverId: body.approverId,
        status: "PENDING",
      })
      .returning();

    return { success: true };
  }

  async pending(orgId: string) {
    const rows = await this.db
      .select({
        id: wfhRequests.id,
        orgId: wfhRequests.orgId,
        userId: wfhRequests.userId,
        date: wfhRequests.date,
        reason: wfhRequests.reason,
        status: wfhRequests.status,
        approverId: wfhRequests.approverId,
        rejectionReason: wfhRequests.rejectionReason,
        createdAt: wfhRequests.createdAt,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userEmail: users.email,
        userImage: users.image,
      })
      .from(wfhRequests)
      .innerJoin(users, eq(wfhRequests.userId, users.id))
      .where(and(eq(wfhRequests.orgId, orgId), eq(wfhRequests.status, "PENDING")))
      .orderBy(desc(wfhRequests.createdAt));

    return rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      userId: r.userId,
      date: r.date,
      reason: r.reason,
      status: r.status,
      approverId: r.approverId,
      rejectionReason: r.rejectionReason,
      createdAt: r.createdAt,
      user: {
        id: r.userId,
        firstName: r.userFirstName,
        lastName: r.userLastName,
        email: r.userEmail,
        image: r.userImage,
      },
    }));
  }

  async update(orgId: string, approverId: string, requestId: number, body: UpdateWfhInput) {
    const existing = await this.db.query.wfhRequests.findFirst({
      where: and(eq(wfhRequests.id, requestId), eq(wfhRequests.orgId, orgId)),
    });

    if (!existing) throw new NotFoundException("WFH request not found.");

    await this.db
      .update(wfhRequests)
      .set({
        status: body.status,
        rejectionReason: body.status === "REJECTED" ? (body.rejectionReason ?? null) : null,
        approverId,
      })
      .where(eq(wfhRequests.id, requestId));

    return { success: true };
  }
}
