import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../directory/employment-query";
import {
  auditLogs,
  hrDataRequests,
  hrEmployeeSensitiveFields,
  hrEmployments,
  hrLegalHolds,
  hrPeople,
  organizationMembers,
  organizationPeople,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../db/drizzle.types";
import type { GdprRectificationBody } from "./dto/gdpr-rectification.schemas";

interface CorrectionResult {
  changed: boolean;
  beforeHash: string;
  afterHash: string;
}

type HrProfileInput = Extract<GdprRectificationBody, { field: `hr_profile.${string}` }>;

@Injectable()
export class GdprRectificationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async rectifyOwnProfile(
    orgId: string,
    subjectUserId: string,
    input: GdprRectificationBody,
    ipAddress?: string,
  ) {
    const hold = await this.findActiveLegalHold(subjectUserId, orgId);
    if (hold) throw new ConflictException("Rectification is blocked by an active legal hold");

    return this.db.transaction(async (tx) => {
      const [membership] = await tx
        .select({ id: organizationMembers.id, status: organizationMembers.status })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, subjectUserId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .limit(1);
      if (!membership || membership.status !== "ACTIVE")
        throw new NotFoundException("Subject not found in active organization");

      let result: CorrectionResult;
      if (input.field === "profile.name")
        result = await this.applyUserNameCorrection(tx, subjectUserId, input.value);
      else if (input.field === "hr_sensitive.bank_details")
        result = await this.applySensitiveFieldCorrection(tx, orgId, subjectUserId, input.value);
      else
        result = await this.applyOrgPersonCorrection(tx, orgId, subjectUserId, input);

      const [request] = await tx
        .insert(hrDataRequests)
        .values({
          orgId,
          subjectUserId,
          type: "correction",
          status: "completed",
          requestedBy: subjectUserId,
          reason: input.field,
          completedAt: new Date(),
        })
        .returning({ id: hrDataRequests.id });
      if (!request) throw new ConflictException("Rectification request could not be recorded");

      await tx.insert(auditLogs).values({
        action: result.changed ? "gdpr.rectification.completed" : "gdpr.rectification.no_change",
        userId: subjectUserId,
        orgId,
        targetId: subjectUserId,
        targetType: "user",
        actorUserId: subjectUserId,
        resourceType: "gdpr_rectification",
        resourceId: String(request.id),
        metadata: {
          field: input.field,
          beforeHash: result.beforeHash,
          afterHash: result.afterHash,
          changed: result.changed,
        },
        ipAddress,
      });

      return { requestId: request.id, field: input.field, changed: result.changed, status: "completed" as const };
    });
  }

  private async applyUserNameCorrection(
    tx: TenantTx,
    subjectUserId: string,
    value: string,
  ): Promise<CorrectionResult> {
    const [current] = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, subjectUserId))
      .limit(1);
    if (!current) throw new NotFoundException("Subject not found");

    const changed = current.name !== value;
    let correctedName = current.name;
    if (changed) {
      const currentNameCondition =
        current.name === null ? isNull(users.name) : eq(users.name, current.name);
      const [updated] = await tx
        .update(users)
        .set({ name: value })
        .where(and(eq(users.id, subjectUserId), currentNameCondition))
        .returning({ name: users.name });
      if (!updated || updated.name !== value)
        throw new ConflictException("Rectification could not be verified");
      correctedName = updated.name;
    }
    return {
      changed,
      beforeHash: this.valueHash(current.name),
      afterHash: this.valueHash(correctedName),
    };
  }

  private async applyOrgPersonCorrection(
    tx: TenantTx,
    orgId: string,
    subjectUserId: string,
    input: HrProfileInput,
  ): Promise<CorrectionResult> {
    const [person] = await tx
      .select({
        id: organizationPeople.organizationPersonId,
        personalEmail: organizationPeople.personalEmail,
        phone: organizationPeople.phone,
        dateOfBirth: organizationPeople.dateOfBirth,
        gender: organizationPeople.gender,
        preferredName: organizationPeople.preferredName,
        address: organizationPeople.address,
        emergencyContact: organizationPeople.emergencyContact,
      })
      .from(organizationPeople)
      .where(
        and(
          eq(organizationPeople.organizationId, orgId),
          eq(organizationPeople.userId, subjectUserId),
          isNull(organizationPeople.deletedAt),
        ),
      )
      .limit(1);
    if (!person) throw new NotFoundException("HR profile not found for subject in this organization");

    const where = and(
      eq(organizationPeople.organizationPersonId, person.id),
      eq(organizationPeople.organizationId, orgId),
    );
    let currentRaw: unknown;
    let attempted = false;

    switch (input.field) {
      case "hr_profile.personal_email": {
        currentRaw = person.personalEmail;
        if (currentRaw !== input.value) {
          attempted = true;
          const [u] = await tx
            .update(organizationPeople)
            .set({ personalEmail: input.value })
            .where(where)
            .returning({ id: organizationPeople.organizationPersonId });
          if (!u) throw new ConflictException("Rectification could not be verified");
        }
        break;
      }
      case "hr_profile.phone": {
        currentRaw = person.phone;
        if (currentRaw !== input.value) {
          attempted = true;
          const [u] = await tx
            .update(organizationPeople)
            .set({ phone: input.value })
            .where(where)
            .returning({ id: organizationPeople.organizationPersonId });
          if (!u) throw new ConflictException("Rectification could not be verified");
        }
        break;
      }
      case "hr_profile.date_of_birth": {
        currentRaw = person.dateOfBirth;
        if (currentRaw !== input.value) {
          attempted = true;
          const [u] = await tx
            .update(organizationPeople)
            .set({ dateOfBirth: input.value })
            .where(where)
            .returning({ id: organizationPeople.organizationPersonId });
          if (!u) throw new ConflictException("Rectification could not be verified");
        }
        break;
      }
      case "hr_profile.gender": {
        currentRaw = person.gender;
        if (currentRaw !== input.value) {
          attempted = true;
          const [u] = await tx
            .update(organizationPeople)
            .set({ gender: input.value })
            .where(where)
            .returning({ id: organizationPeople.organizationPersonId });
          if (!u) throw new ConflictException("Rectification could not be verified");
        }
        break;
      }
      case "hr_profile.preferred_name": {
        currentRaw = person.preferredName;
        if (currentRaw !== input.value) {
          attempted = true;
          const [u] = await tx
            .update(organizationPeople)
            .set({ preferredName: input.value })
            .where(where)
            .returning({ id: organizationPeople.organizationPersonId });
          if (!u) throw new ConflictException("Rectification could not be verified");
        }
        break;
      }
      case "hr_profile.address": {
        currentRaw = person.address;
        if (JSON.stringify(currentRaw) !== JSON.stringify(input.value)) {
          attempted = true;
          const [u] = await tx
            .update(organizationPeople)
            .set({ address: input.value })
            .where(where)
            .returning({ id: organizationPeople.organizationPersonId });
          if (!u) throw new ConflictException("Rectification could not be verified");
        }
        break;
      }
      case "hr_profile.emergency_contact": {
        currentRaw = person.emergencyContact;
        if (JSON.stringify(currentRaw) !== JSON.stringify(input.value)) {
          attempted = true;
          const [u] = await tx
            .update(organizationPeople)
            .set({ emergencyContact: input.value })
            .where(where)
            .returning({ id: organizationPeople.organizationPersonId });
          if (!u) throw new ConflictException("Rectification could not be verified");
        }
        break;
      }
    }

    return {
      changed: attempted,
      beforeHash: this.valueHash(currentRaw),
      afterHash: this.valueHash(input.value),
    };
  }

  private async applySensitiveFieldCorrection(
    tx: TenantTx,
    orgId: string,
    subjectUserId: string,
    value: string,
  ): Promise<CorrectionResult> {
    const [employment] = await tx
      .select({ id: hrEmployments.id })
      .from(hrPeople)
      .innerJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
      .where(livePersonOfUser(orgId, subjectUserId))
      .limit(1);
    if (!employment)
      return { changed: false, beforeHash: this.valueHash(null), afterHash: this.valueHash(value) };

    const [sensitive] = await tx
      .select({ id: hrEmployeeSensitiveFields.id, bankDetails: hrEmployeeSensitiveFields.bankDetails })
      .from(hrEmployeeSensitiveFields)
      .where(
        and(
          eq(hrEmployeeSensitiveFields.orgId, orgId),
          eq(hrEmployeeSensitiveFields.employmentId, employment.id),
        ),
      )
      .limit(1);
    if (!sensitive)
      return { changed: false, beforeHash: this.valueHash(null), afterHash: this.valueHash(value) };

    const changed = sensitive.bankDetails !== value;
    if (changed) {
      const [updated] = await tx
        .update(hrEmployeeSensitiveFields)
        .set({ bankDetails: value })
        .where(
          and(
            eq(hrEmployeeSensitiveFields.orgId, orgId),
            eq(hrEmployeeSensitiveFields.id, sensitive.id),
          ),
        )
        .returning({ id: hrEmployeeSensitiveFields.id });
      if (!updated) throw new ConflictException("Rectification could not be verified");
    }
    return {
      changed,
      beforeHash: this.valueHash(sensitive.bankDetails),
      afterHash: this.valueHash(value),
    };
  }

  private async findActiveLegalHold(
    userId: string,
    orgId: string,
  ): Promise<{ id: number; reason: string } | null> {
    const [row] = await this.db
      .select({ id: hrLegalHolds.id, reason: hrLegalHolds.reason })
      .from(hrLegalHolds)
      .where(
        and(
          eq(hrLegalHolds.subjectUserId, userId),
          eq(hrLegalHolds.orgId, orgId),
          eq(hrLegalHolds.status, "active"),
          isNull(hrLegalHolds.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private valueHash(value: unknown): string {
    const str =
      value === null || value === undefined
        ? ""
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
    return createHash("sha256").update(str).digest("hex");
  }
}
