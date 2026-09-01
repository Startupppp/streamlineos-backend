import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import {
  areCompatibilityRelationsAvailable,
  isCompatibilityRelationAvailable,
} from "../../../common/db/expand-contract-compat";
import type { TenantTx } from "../../../db/drizzle.types";
import { organizationPeople, workerEngagements, workers } from "../../../db/schema";
import { hrmsMigrationProfiles } from "../../../db/schema/directory/hrms-migration-profile";
import {
  attendanceEventLocators,
  attendanceEvents,
} from "../../../db/schema/hr/attendance-event-store";

export type AttendanceEventKind =
  | "CHECK_IN"
  | "CHECK_OUT"
  | "BREAK_START"
  | "BREAK_END";

export interface AttendanceCommandIdentity {
  organizationId: string;
  actorUserId: string;
  businessDate: string;
  organizationTimezone: string;
  commandScope: string;
  commandId: string;
}

export type PreparedAttendanceCommand =
  | { state: "REPLAY" }
  | {
      state: "CANONICAL";
      organizationId: string;
      actorUserId: string;
      actorMembershipId: number | null;
      businessDate: string;
      organizationTimezone: string;
      commandScope: string;
      commandId: string;
      workerId: string;
      workerEngagementId: string;
    };

export interface AttendanceEventEffect {
  eventKind: AttendanceEventKind;
  occurredAt: Date;
  geofenceId?: number;
  geofencePassed?: boolean;
}

const CANONICAL_NOT_READY = {
  code: "HRMS_ATTENDANCE_CANONICAL_NOT_READY",
  message:
    "Attendance is temporarily unavailable while canonical attendance storage is being activated.",
};

@Injectable()
export class AttendanceEventWriterService {
  async prepareCommand(
    transaction: TenantTx,
    identity: AttendanceCommandIdentity,
  ): Promise<PreparedAttendanceCommand | null> {
    const profileAvailable = await isCompatibilityRelationAvailable(
      transaction,
      "public.hrms_migration_profiles",
    );
    if (!profileAvailable) return null;

    const [profile] = await transaction
      .select({ attendanceWriteMode: hrmsMigrationProfiles.attendanceWriteMode })
      .from(hrmsMigrationProfiles)
      .where(eq(hrmsMigrationProfiles.organizationId, identity.organizationId))
      .limit(1);
    const attendanceWriteMode = profile?.attendanceWriteMode ?? "LEGACY";
    if (attendanceWriteMode === "LEGACY") return null;
    if (attendanceWriteMode !== "DUAL") {
      throw new ServiceUnavailableException(CANONICAL_NOT_READY);
    }

    await this.requireCanonicalRelations(transaction);

    const normalizedCommandId = identity.commandId.trim();
    const [existingLocator] = await transaction
      .select({ eventId: attendanceEventLocators.eventId })
      .from(attendanceEventLocators)
      .where(
        and(
          eq(attendanceEventLocators.organizationId, identity.organizationId),
          eq(attendanceEventLocators.commandScope, identity.commandScope),
          eq(attendanceEventLocators.commandId, normalizedCommandId),
        ),
      )
      .limit(1);
    if (existingLocator) return { state: "REPLAY" };

    const [canonicalSubject] = await transaction
      .select({
        workerId: workers.workerId,
        workerEngagementId: workerEngagements.workerEngagementId,
        actorMembershipId: organizationPeople.organizationMembershipId,
      })
      .from(organizationPeople)
      .innerJoin(
        workers,
        and(
          eq(workers.organizationId, organizationPeople.organizationId),
          eq(
            workers.organizationPersonId,
            organizationPeople.organizationPersonId,
          ),
          eq(workers.status, "ACTIVE"),
          isNull(workers.archivedAt),
          isNull(workers.deletedAt),
        ),
      )
      .innerJoin(
        workerEngagements,
        and(
          eq(workerEngagements.organizationId, workers.organizationId),
          eq(workerEngagements.workerId, workers.workerId),
          eq(workerEngagements.status, "ACTIVE"),
          eq(workerEngagements.isPrimary, true),
          lte(workerEngagements.startsOn, identity.businessDate),
          or(
            isNull(workerEngagements.endsOn),
            gt(workerEngagements.endsOn, identity.businessDate),
          ),
          isNull(workerEngagements.archivedAt),
        ),
      )
      .where(
        and(
          eq(organizationPeople.organizationId, identity.organizationId),
          eq(organizationPeople.userId, identity.actorUserId),
          isNull(organizationPeople.archivedAt),
          isNull(organizationPeople.deletedAt),
        ),
      )
      .orderBy(desc(workerEngagements.startsOn))
      .limit(1);

    if (!canonicalSubject) {
      throw new ServiceUnavailableException({
        code: "HRMS_ATTENDANCE_SUBJECT_NOT_READY",
        message:
          "Attendance is temporarily unavailable while the employee record is being reconciled.",
      });
    }

    return {
      state: "CANONICAL",
      ...identity,
      commandId: normalizedCommandId,
      ...canonicalSubject,
    };
  }

  async appendEvents(
    transaction: TenantTx,
    command: Extract<PreparedAttendanceCommand, { state: "CANONICAL" }>,
    effects: readonly AttendanceEventEffect[],
  ): Promise<void> {
    if (effects.length === 0) return;

    const effectOrdinals = effects.map(
      (_unusedEffect, effectOrdinal) => effectOrdinal,
    );
    const locators = await transaction
      .insert(attendanceEventLocators)
      .values(
        effects.map((_unusedEffect, effectOrdinal) => ({
          organizationId: command.organizationId,
          businessDate: command.businessDate,
          commandScope: command.commandScope,
          commandId: command.commandId,
          effectOrdinal,
          sourceType: "COMMAND",
          sourceId: command.commandId,
          sourceOrdinal: effectOrdinal,
        })),
      )
      .onConflictDoNothing({
        target: [
          attendanceEventLocators.organizationId,
          attendanceEventLocators.commandScope,
          attendanceEventLocators.commandId,
          attendanceEventLocators.effectOrdinal,
        ],
      })
      .returning({
        eventId: attendanceEventLocators.eventId,
        effectOrdinal: attendanceEventLocators.effectOrdinal,
      });

    if (locators.length === 0) {
      await this.assertCompleteReplay(transaction, command, effectOrdinals);
      return;
    }
    if (locators.length !== effects.length) {
      throw new ServiceUnavailableException(CANONICAL_NOT_READY);
    }

    const locatorByOrdinal = new Map(
      locators.map((locator) => [locator.effectOrdinal, locator.eventId]),
    );
    await transaction.insert(attendanceEvents).values(
      effects.map((effect, effectOrdinal) => {
        const eventId = locatorByOrdinal.get(effectOrdinal);
        if (eventId === undefined) {
          throw new ServiceUnavailableException(CANONICAL_NOT_READY);
        }
        const hasGeofence = effect.geofenceId !== undefined;
        return {
          organizationId: command.organizationId,
          businessDate: command.businessDate,
          eventId,
          workerId: command.workerId,
          workerEngagementId: command.workerEngagementId,
          eventKind: effect.eventKind,
          occurredAt: effect.occurredAt,
          organizationTimezone: command.organizationTimezone,
          eventSource: "SELF_SERVICE" as const,
          commandScope: command.commandScope,
          commandId: command.commandId,
          effectOrdinal,
          sourceType: "COMMAND",
          sourceId: command.commandId,
          sourceOrdinal: effectOrdinal,
          actorMembershipId: command.actorMembershipId,
          actorUserId: command.actorUserId,
          geofenceId: effect.geofenceId ?? null,
          geofencePassed: hasGeofence ? (effect.geofencePassed ?? false) : null,
          accuracyBucket: hasGeofence ? ("UNKNOWN" as const) : null,
          distanceBucket:
            hasGeofence && effect.geofencePassed
              ? ("INSIDE_RADIUS" as const)
              : null,
        };
      }),
    );
  }

  private async requireCanonicalRelations(transaction: TenantTx): Promise<void> {
    const requiredRelations = [
      "public.attendance_event_locators",
      "public.attendance_events",
      "public.organization_people",
      "public.workers",
      "public.worker_engagements",
    ] as const;
    const relationsAvailable = await areCompatibilityRelationsAvailable(
      transaction,
      requiredRelations,
    );
    if (!relationsAvailable) {
      throw new ServiceUnavailableException(CANONICAL_NOT_READY);
    }
  }

  private async assertCompleteReplay(
    transaction: TenantTx,
    command: Extract<PreparedAttendanceCommand, { state: "CANONICAL" }>,
    effectOrdinals: number[],
  ): Promise<void> {
    const existingLocators = await transaction
      .select({ effectOrdinal: attendanceEventLocators.effectOrdinal })
      .from(attendanceEventLocators)
      .where(
        and(
          eq(attendanceEventLocators.organizationId, command.organizationId),
          eq(attendanceEventLocators.commandScope, command.commandScope),
          eq(attendanceEventLocators.commandId, command.commandId),
          inArray(attendanceEventLocators.effectOrdinal, effectOrdinals),
        ),
      )
      .limit(effectOrdinals.length);
    if (existingLocators.length !== effectOrdinals.length) {
      throw new ServiceUnavailableException(CANONICAL_NOT_READY);
    }
  }
}
