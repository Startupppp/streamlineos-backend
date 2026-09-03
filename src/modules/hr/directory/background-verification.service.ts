import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { backgroundVerifications } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateBgvInput, UpdateBgvInput } from "./dto/hr-directory.schemas";
import { EmploymentFactsService } from "../../directory/employment-facts.service";

@Injectable()
export class BackgroundVerificationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly employmentFacts: EmploymentFactsService,
  ) {}

  async list(orgId: string) {
    const rows = await this.db.query.backgroundVerifications.findMany({
      where: eq(backgroundVerifications.orgId, orgId),
      limit: 100,
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            firstName: true,
            lastName: true,
            email: true,
            image: true,
          },
        },
      },
      orderBy: [desc(backgroundVerifications.createdAt)],
    });

    const facts = await this.employmentFacts.getFactsBatch(
      orgId,
      rows.map((row) => row.user?.id).filter((id): id is string => Boolean(id)),
    );

    return rows.map((row) => ({
      ...row,
      user: row.user
        ? {
            ...row.user,
            designation: facts.get(row.user.id)?.designation ?? null,
            employeeId: facts.get(row.user.id)?.employeeNumber ?? null,
          }
        : row.user,
    }));
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
      columns: { id: true },
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
      .where(and(eq(backgroundVerifications.id, body.id), eq(backgroundVerifications.orgId, orgId)));

    return { success: true };
  }
}
