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

const PERSON_JOIN_COND = and(
  eq(organizationPeople.organizationId, hrPeople.orgId),
  eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
  isNull(organizationPeople.deletedAt),
);

const PERSON_VIEW_COLUMNS = {
  id: hrPeople.id,
  orgId: hrPeople.orgId,
  userId: hrPeople.userId,
  organizationPersonId: hrPeople.organizationPersonId,
  firstName: organizationPeople.firstName,
  lastName: organizationPeople.lastName,
  workEmail: organizationPeople.workEmail,
  phone: organizationPeople.phone,
  gender: organizationPeople.gender,
  avatarUrl: organizationPeople.avatarUrl,
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
      .innerJoin(organizationPeople, PERSON_JOIN_COND)
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
    const [row] = await this.db
      .select({
        id: hrPeople.id,
        organizationPersonId: hrPeople.organizationPersonId,
        workEmail: organizationPeople.workEmail,
      })
      .from(hrPeople)
      .innerJoin(organizationPeople, PERSON_JOIN_COND)
      .where(
        and(
          eq(hrPeople.id, personId),
          eq(hrPeople.orgId, orgId),
          isNull(hrPeople.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Person not found");
    return row;
  }

  private async findOrCreateCanonicalPersonId(
    orgId: string,
    workEmail: string,
    firstName: string,
    lastName: string,
  ): Promise<{ organizationPersonId: string; created: boolean }> {
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
    if (match) return { organizationPersonId: match.organizationPersonId, created: false };

    const [created] = await this.db
      .insert(organizationPeople)
      .values({ organizationId: orgId, firstName, lastName, workEmail })
      .returning({ organizationPersonId: organizationPeople.organizationPersonId });
    if (!created) throw new Error("Failed to create canonical person record");
    return { organizationPersonId: created.organizationPersonId, created: true };
  }

  async create(orgId: string, actorId: string, input: CreatePersonInput) {
    const workEmail = input.workEmail.toLowerCase().trim();
    const [existing] = await this.db
      .select({ id: hrPeople.id })
      .from(hrPeople)
      .innerJoin(organizationPeople, PERSON_JOIN_COND)
      .where(
        and(
          eq(hrPeople.orgId, orgId),
          sql`lower(trim(${organizationPeople.workEmail})) = ${workEmail}`,
          isNull(hrPeople.deletedAt),
        ),
      )
      .limit(1);
    if (existing) throw new ConflictException("A person with this work email already exists");

    const { organizationPersonId, created: newCanonical } =
      await this.findOrCreateCanonicalPersonId(orgId, workEmail, input.firstName, input.lastName);

    const hasExtraIdentity =
      input.personalEmail !== undefined ||
      input.phone !== undefined ||
      input.dateOfBirth !== undefined ||
      input.gender !== undefined ||
      input.nationality !== undefined ||
      input.address !== undefined ||
      input.emergencyContact !== undefined ||
      input.avatarUrl !== undefined;

    if (newCanonical && hasExtraIdentity) {
      await this.db
        .update(organizationPeople)
        .set({
          ...(input.personalEmail !== undefined && { personalEmail: input.personalEmail?.toLowerCase().trim() ?? null }),
          ...(input.phone !== undefined && { phone: input.phone }),
          ...(input.dateOfBirth !== undefined && { dateOfBirth: input.dateOfBirth }),
          ...(input.gender !== undefined && { gender: input.gender }),
          ...(input.nationality !== undefined && { nationality: input.nationality }),
          ...(input.address !== undefined && { address: input.address }),
          ...(input.emergencyContact !== undefined && { emergencyContact: input.emergencyContact }),
          ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
        })
        .where(
          and(
            eq(organizationPeople.organizationId, orgId),
            eq(organizationPeople.organizationPersonId, organizationPersonId),
          ),
        );
    }

    const [created] = await this.db
      .insert(hrPeople)
      .values({
        orgId,
        organizationPersonId,
      })
      .returning({ id: hrPeople.id })
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
      after: { organizationPersonId, workEmail },
    });

    return this.getOne(orgId, actorId, created.id, "all");
  }

  async update(orgId: string, personId: number, actorId: string, input: UpdatePersonInput) {
    const existing = await this.getOneForMutation(orgId, personId);

    if (!existing.organizationPersonId) throw new NotFoundException("Person not found");

    if (input.workEmail !== undefined) {
      const newEmail = input.workEmail.toLowerCase().trim();
      if (newEmail !== (existing.workEmail?.toLowerCase() ?? "")) {
        const [dup] = await this.db
          .select({ id: hrPeople.id })
          .from(hrPeople)
          .innerJoin(organizationPeople, PERSON_JOIN_COND)
          .where(
            and(
              eq(hrPeople.orgId, orgId),
              sql`lower(trim(${organizationPeople.workEmail})) = ${newEmail}`,
              isNull(hrPeople.deletedAt),
            ),
          )
          .limit(1);
        if (dup && dup.id !== personId) {
          throw new ConflictException("A person with this work email already exists");
        }
      }
    }

    await this.db
      .update(organizationPeople)
      .set({
        ...(input.firstName !== undefined && { firstName: input.firstName }),
        ...(input.lastName !== undefined && { lastName: input.lastName }),
        ...(input.workEmail !== undefined && { workEmail: input.workEmail.toLowerCase().trim() }),
        ...(input.personalEmail !== undefined && { personalEmail: input.personalEmail?.toLowerCase().trim() ?? null }),
        ...(input.phone !== undefined && { phone: input.phone }),
        ...(input.dateOfBirth !== undefined && { dateOfBirth: input.dateOfBirth }),
        ...(input.gender !== undefined && { gender: input.gender }),
        ...(input.nationality !== undefined && { nationality: input.nationality }),
        ...(input.address !== undefined && { address: input.address }),
        ...(input.emergencyContact !== undefined && { emergencyContact: input.emergencyContact }),
        ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
      })
      .where(
        and(
          eq(organizationPeople.organizationId, orgId),
          eq(organizationPeople.organizationPersonId, existing.organizationPersonId),
        ),
      );

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_people",
      entityId: String(personId),
      action: "updated",
      before: { organizationPersonId: existing.organizationPersonId, workEmail: existing.workEmail },
      after: input,
    });

    return this.getOne(orgId, actorId, personId, "all");
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
      before: { organizationPersonId: existing.organizationPersonId, workEmail: existing.workEmail },
    });

    return { success: true };
  }
}
