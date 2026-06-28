import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { backgroundVerifications } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateBgvInput, UpdateBgvInput } from "./dto/hr-directory.schemas";

@Injectable()
export class BackgroundVerificationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db.query.backgroundVerifications.findMany({
      where: eq(backgroundVerifications.orgId, orgId),
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            firstName: true,
            lastName: true,
            email: true,
            image: true,
            designation: true,
            employeeId: true,
          },
        },
      },
      orderBy: [desc(backgroundVerifications.createdAt)],
      limit: 500,
    });
  }

  async create(orgId: string, body: CreateBgvInput) {
    const existing = await this.db.query.backgroundVerifications.findFirst({
      where: and(
        eq(backgroundVerifications.orgId, orgId),
        eq(backgroundVerifications.userId, body.userId),
        eq(backgroundVerifications.type, body.type),
        notInArray(backgroundVerifications.status, ["PASSED", "FAILED"]),
      ),
      columns: { id: true, status: true },
    });
    if (existing) {
      throw new ConflictException(
        `An active ${body.type} verification already exists for this employee (status: ${existing.status}). Complete or update the existing check first.`,
      );
    }

    const [bgv] = await this.db
      .insert(backgroundVerifications)
      .values({
        orgId,
        userId: body.userId,
        type: body.type,
        provider: body.provider,
        referenceNumber: body.referenceNumber,
        notes: body.notes,
        status: "PENDING",
      })
      .returning();

    return bgv;
  }

  async update(orgId: string, body: UpdateBgvInput) {
    const existing = await this.db.query.backgroundVerifications.findFirst({
      where: and(eq(backgroundVerifications.id, body.id), eq(backgroundVerifications.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Verification not found.");

    await this.db
      .update(backgroundVerifications)
      .set({
        ...(body.status && { status: body.status }),
        ...(body.result && { result: body.result }),
        ...(body.notes !== undefined && { notes: body.notes }),
        ...(body.status === "PASSED" || body.status === "FAILED" ? { completedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(backgroundVerifications.id, body.id));

    return { success: true };
  }
}
