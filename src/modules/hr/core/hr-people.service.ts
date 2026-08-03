import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { hrPeople } from "../../../db/schema/hr/core-people";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { CreatePersonInput, UpdatePersonInput } from "./dto/hr-core.schemas";
import { HrAuditService } from "./hr-audit.service";

@Injectable()
export class HrPeopleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async list(orgId: string, opts: { page: number; limit: number; search?: string }) {
    const { page, limit, search } = opts;
    const offset = (page - 1) * limit;

    const baseWhere = and(
      eq(hrPeople.orgId, orgId),
      isNull(hrPeople.deletedAt),
    );

    const where = search
      ? and(
          baseWhere,
          or(
            ilike(hrPeople.firstName, `%${search}%`),
            ilike(hrPeople.lastName, `%${search}%`),
            ilike(hrPeople.workEmail, `%${search}%`),
          ),
        )
      : baseWhere;

    const [data, totalResult] = await Promise.all([
      this.db
        .select({
          id: hrPeople.id,
          orgId: hrPeople.orgId,
          userId: hrPeople.userId,
          firstName: hrPeople.firstName,
          lastName: hrPeople.lastName,
          workEmail: hrPeople.workEmail,
          phone: hrPeople.phone,
          gender: hrPeople.gender,
          avatarUrl: hrPeople.avatarUrl,
          createdAt: hrPeople.createdAt,
        })
        .from(hrPeople)
        .where(where)
        .orderBy(hrPeople.firstName)
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrPeople).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getOne(orgId: string, personId: number) {
    const person = await this.db.query.hrPeople.findFirst({
      where: and(
        eq(hrPeople.id, personId),
        eq(hrPeople.orgId, orgId),
        isNull(hrPeople.deletedAt),
      ),
    });
    if (!person) throw new NotFoundException("Person not found");
    return person;
  }

  async create(orgId: string, actorId: string, input: CreatePersonInput) {
    const [existing] = await this.db
      .select({ id: hrPeople.id })
      .from(hrPeople)
      .where(
        and(
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.workEmail, input.workEmail.toLowerCase().trim()),
          isNull(hrPeople.deletedAt),
        ),
      )
      .limit(1);
    if (existing) throw new ConflictException("A person with this work email already exists");

    const [created] = await this.db
      .insert(hrPeople)
      .values({
        orgId,
        firstName: input.firstName,
        lastName: input.lastName,
        workEmail: input.workEmail.toLowerCase().trim(),
        personalEmail: input.personalEmail?.toLowerCase().trim() ?? null,
        phone: input.phone ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        gender: input.gender ?? null,
        nationality: input.nationality ?? null,
        address: input.address ?? null,
        emergencyContact: input.emergencyContact ?? null,
        avatarUrl: input.avatarUrl ?? null,
      })
      .returning();

    if (!created) throw new Error("Failed to create person");

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_people",
      entityId: String(created.id),
      action: "created",
      after: created,
    });

    return created;
  }

  async update(orgId: string, personId: number, actorId: string, input: UpdatePersonInput) {
    const existing = await this.getOne(orgId, personId);

    if (input.workEmail && input.workEmail.toLowerCase() !== existing.workEmail) {
      const [dup] = await this.db
        .select({ id: hrPeople.id })
        .from(hrPeople)
        .where(
          and(
            eq(hrPeople.orgId, orgId),
            eq(hrPeople.workEmail, input.workEmail.toLowerCase().trim()),
            isNull(hrPeople.deletedAt),
          ),
        )
        .limit(1);
      if (dup && dup.id !== personId) {
        throw new ConflictException("A person with this work email already exists");
      }
    }

    const [updated] = await this.db
      .update(hrPeople)
      .set({
        ...(input.firstName !== undefined && { firstName: input.firstName }),
        ...(input.lastName !== undefined && { lastName: input.lastName }),
        ...(input.workEmail !== undefined && { workEmail: input.workEmail.toLowerCase().trim() }),
        ...(input.personalEmail !== undefined && { personalEmail: input.personalEmail?.toLowerCase().trim() }),
        ...(input.phone !== undefined && { phone: input.phone }),
        ...(input.dateOfBirth !== undefined && { dateOfBirth: input.dateOfBirth }),
        ...(input.gender !== undefined && { gender: input.gender }),
        ...(input.nationality !== undefined && { nationality: input.nationality }),
        ...(input.address !== undefined && { address: input.address }),
        ...(input.emergencyContact !== undefined && { emergencyContact: input.emergencyContact }),
        ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
      })
      .where(and(eq(hrPeople.id, personId), eq(hrPeople.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Person not found");

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_people",
      entityId: String(personId),
      action: "updated",
      before: existing,
      after: updated,
    });

    return updated;
  }

  async remove(orgId: string, personId: number, actorId: string) {
    const existing = await this.getOne(orgId, personId);

    await this.db
      .update(hrPeople)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(hrPeople.id, personId), eq(hrPeople.orgId, orgId)));

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_people",
      entityId: String(personId),
      action: "deleted",
      before: existing,
    });

    return { success: true };
  }
}
