import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { hrPeople, organizationPeople } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { CreatePersonInput, UpdatePersonInput } from "./dto/hr-core.schemas";
import { HrAuditService } from "./hr-audit.service";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import { getPostgresErrorDetails } from "../../../common/db/postgres-error";

const PERSON_VIEW_COLUMNS = {
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
  updatedAt: hrPeople.updatedAt,
};

@Injectable()
export class HrPeopleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async getOne(
    orgId: string,
    actorUserId: string,
    personId: number,
    scope: DataScope,
  ) {
    const [person] = await this.db
      .select(PERSON_VIEW_COLUMNS)
      .from(hrPeople)
      .where(
        and(
          eq(hrPeople.id, personId),
          eq(hrPeople.orgId, orgId),
          isNull(hrPeople.deletedAt),
          applyScope(scope, orgId, actorUserId, {
            ownerColumn: hrPeople.userId,
          }),
        ),
      )
      .limit(1);
    if (!person) throw new NotFoundException("Person not found");
    return person;
  }

  private async getOneForMutation(orgId: string, personId: number) {
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

  private async findOrCreateCanonicalPersonId(
    orgId: string,
    workEmail: string,
    firstName: string,
    lastName: string,
  ): Promise<string> {
    const [match] = await this.db
      .select({ organizationPersonId: organizationPeople.organizationPersonId })
      .from(organizationPeople)
      .where(
        and(
          eq(organizationPeople.organizationId, orgId),
          sql`lower(trim(${organizationPeople.workEmail})) = ${workEmail}`,
          isNull(organizationPeople.deletedAt),
        ),
      )
      .limit(1);
    if (match) return match.organizationPersonId;

    const [created] = await this.db
      .insert(organizationPeople)
      .values({ organizationId: orgId, firstName, lastName, workEmail })
      .returning({ organizationPersonId: organizationPeople.organizationPersonId });
    if (!created) throw new Error("Failed to create canonical person record");
    return created.organizationPersonId;
  }

  async create(orgId: string, actorId: string, input: CreatePersonInput) {
    const workEmail = input.workEmail.toLowerCase().trim();
    const [existing] = await this.db
      .select({ id: hrPeople.id })
      .from(hrPeople)
      .where(
        and(
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.workEmail, workEmail),
          isNull(hrPeople.deletedAt),
        ),
      )
      .limit(1);
    if (existing) throw new ConflictException("A person with this work email already exists");

    const organizationPersonId = await this.findOrCreateCanonicalPersonId(
      orgId,
      workEmail,
      input.firstName,
      input.lastName,
    );

    const [created] = await this.db
      .insert(hrPeople)
      .values({
        orgId,
        organizationPersonId,
        firstName: input.firstName,
        lastName: input.lastName,
        workEmail,
        personalEmail: input.personalEmail?.toLowerCase().trim() ?? null,
        phone: input.phone ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        gender: input.gender ?? null,
        nationality: input.nationality ?? null,
        address: input.address ?? null,
        emergencyContact: input.emergencyContact ?? null,
        avatarUrl: input.avatarUrl ?? null,
      })
      .returning()
      .catch((err: unknown) => {
        const { code, constraint } = getPostgresErrorDetails(err);
        if (code === "23505" && constraint === "uniq_hr_people_org_person_link")
          throw new ConflictException("This person already has an employment record in this organisation");
        throw err;
      });

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
    const existing = await this.getOneForMutation(orgId, personId);

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
    const existing = await this.getOneForMutation(orgId, personId);

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
