import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";
import { projectRetentionSettings, projectStatuses, tickets } from "../../db/schema";
import { projectAttachments } from "../../db/schema/build/project-attachments";
import { organizationLegalHolds } from "../../db/schema/common/organization-purge";
import { storagePendingPurge } from "../../db/schema/common/storage-pending-purge";
import { StorageService } from "../storage/storage.service";
import { StoragePendingPurgeService } from "../storage/storage-pending-purge.service";

export const BUILD_PROJECT_RETENTION_SWEEP = "build-project-retention";
export const BUILD_PROJECT_RETENTION_AUDIT_ACTION = "build.retention.purge";
export const COMPLETED_STATE_GROUP = "completed";

const DAY_MS = 86_400_000;
const DELETE_BATCH_SIZE = 200;
const SETTINGS_PAGE_SIZE = 200;

export const BUILD_PROJECT_RETENTION_RUN_BUDGET = 5_000;
const BUILD_ATTACHMENT_PURGE_PURPOSE = "build:project-attachment:retention";

export type BuildRetentionEntity = "closed_tickets" | "project_attachments";

export type BuildRetentionSkipReason =
  | "legal_hold"
  | "inherits_org_policy"
  | "no_configured_period";

export interface BuildRetentionSettingsRow {
  id: number;
  projectId: number;
  inheritOrgPolicy: boolean;
  closedTicketRetentionDays: number | null;
  attachmentRetentionDays: number | null;
  legalHold: boolean;
  legalHoldReason: string | null;
}

export type BuildRetentionDecision =
  | { projectId: number; eligible: false; reason: BuildRetentionSkipReason }
  | {
      projectId: number;
      eligible: true;
      ticketCutoff: Date | null;
      attachmentCutoff: Date | null;
    };

export interface BuildProjectRetentionPurgeResult {
  dryRun: boolean;
  organizations: number;
  organizationsFailed: number;
  organizationsHeld: number;
  projectsPurged: number;
  projectsHeld: number;
  projectsUnconfigured: number;
  ticketsDeleted: number;
  ticketsWouldDelete: number;
  attachmentsDeleted: number;
  attachmentsWouldDelete: number;
  truncated: boolean;
}

function configuredDays(value: number | null): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function decideBuildRetention(
  row: BuildRetentionSettingsRow,
  now: Date,
): BuildRetentionDecision {
  if (row.legalHold) return { projectId: row.projectId, eligible: false, reason: "legal_hold" };
  if (row.inheritOrgPolicy)
    return { projectId: row.projectId, eligible: false, reason: "inherits_org_policy" };

  const ticketDays = configuredDays(row.closedTicketRetentionDays);
  const attachmentDays = configuredDays(row.attachmentRetentionDays);
  if (ticketDays === null && attachmentDays === null)
    return { projectId: row.projectId, eligible: false, reason: "no_configured_period" };

  return {
    projectId: row.projectId,
    eligible: true,
    ticketCutoff: ticketDays === null ? null : new Date(now.getTime() - ticketDays * DAY_MS),
    attachmentCutoff:
      attachmentDays === null ? null : new Date(now.getTime() - attachmentDays * DAY_MS),
  };
}

export function closedTicketPurgePredicate(
  orgId: string,
  projectId: number,
  cutoff: Date,
): SQL | undefined {
  return and(
    eq(tickets.orgId, orgId),
    eq(tickets.projectId, projectId),
    isNotNull(tickets.deletedAt),
    lt(tickets.deletedAt, cutoff),
    sql`EXISTS (
      SELECT 1 FROM ${projectStatuses}
      WHERE ${projectStatuses.orgId} = ${tickets.orgId}
        AND ${projectStatuses.projectId} = ${tickets.projectId}
        AND ${projectStatuses.name} = ${tickets.status}
        AND ${projectStatuses.type} = ${COMPLETED_STATE_GROUP}
    )`,
  );
}

export function projectAttachmentPurgePredicate(
  orgId: string,
  projectId: number,
  cutoff: Date,
): SQL | undefined {
  return and(
    eq(projectAttachments.orgId, orgId),
    eq(projectAttachments.projectId, projectId),
    isNotNull(projectAttachments.deletedAt),
    lt(projectAttachments.deletedAt, cutoff),
  );
}

@Injectable()
export class CronBuildProjectRetentionService {
  private readonly logger = new Logger(CronBuildProjectRetentionService.name);
  private resumeAfterOrgId: string | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly pendingPurge: StoragePendingPurgeService,
  ) {}

  async sweep(
    opts: { confirm?: boolean; now?: Date } = {},
  ): Promise<BuildProjectRetentionPurgeResult> {
    const dryRun = opts.confirm !== true;
    const now = opts.now ?? new Date();

    const result: BuildProjectRetentionPurgeResult = {
      dryRun,
      organizations: 0,
      organizationsFailed: 0,
      organizationsHeld: 0,
      projectsPurged: 0,
      projectsHeld: 0,
      projectsUnconfigured: 0,
      ticketsDeleted: 0,
      ticketsWouldDelete: 0,
      attachmentsDeleted: 0,
      attachmentsWouldDelete: 0,
      truncated: false,
    };

    const budgetSpent = () =>
      result.ticketsDeleted +
        result.ticketsWouldDelete +
        result.attachmentsDeleted +
        result.attachmentsWouldDelete >=
      BUILD_PROJECT_RETENTION_RUN_BUDGET;
    let lastVisitedOrgId: string | null = null;
    const attachmentPurgeIds = new Map<string, Map<string, string>>();

    const outcome = await forEachOrg(
      this.db,
      BUILD_PROJECT_RETENTION_SWEEP,
      async (tx, orgId) => {
        lastVisitedOrgId = orgId;
        await this.sweepOrg(tx, orgId, now, dryRun, result, attachmentPurgeIds);
      },
      "write",
      { startAfterOrgId: this.resumeAfterOrgId, stopWhen: budgetSpent },
    );

    await this.deleteAttachmentObjects(attachmentPurgeIds);

    result.organizations = outcome.organizations;
    result.organizationsFailed = outcome.failed;
    if (budgetSpent()) {
      result.truncated = true;
      this.resumeAfterOrgId = lastVisitedOrgId;
    } else {
      this.resumeAfterOrgId = null;
    }

    this.logger.log(
      `[${BUILD_PROJECT_RETENTION_SWEEP}] dryRun=${dryRun} orgs=${result.organizations} ` +
        `orgsHeld=${result.organizationsHeld} purged=${result.projectsPurged} ` +
        `held=${result.projectsHeld} unconfigured=${result.projectsUnconfigured} ` +
        `tickets=${result.ticketsDeleted}/${result.ticketsWouldDelete} ` +
        `attachments=${result.attachmentsDeleted}/${result.attachmentsWouldDelete} ` +
        `truncated=${result.truncated}`,
    );

    return result;
  }

  private async sweepOrg(
    tx: TenantTx,
    orgId: string,
    now: Date,
    dryRun: boolean,
    result: BuildProjectRetentionPurgeResult,
    attachmentPurgeIds: Map<string, Map<string, string>>,
  ): Promise<void> {
    if (await this.organizationHeld(tx, orgId)) {
      result.organizationsHeld += 1;
      this.logger.log(
        `[${BUILD_PROJECT_RETENTION_SWEEP}] org=${orgId} skipped: an organization legal hold is active`,
      );
      return;
    }

    for (const row of await this.readSettings(tx, orgId)) {
      const decision = decideBuildRetention(row, now);

      if (!decision.eligible) {
        if (decision.reason === "legal_hold") {
          result.projectsHeld += 1;
          this.logger.log(
            `[${BUILD_PROJECT_RETENTION_SWEEP}] org=${orgId} project=${row.projectId} skipped: ` +
              `legal hold (${row.legalHoldReason ?? "no reason recorded"})`,
          );
        } else {
          result.projectsUnconfigured += 1;
        }
        continue;
      }

      result.projectsPurged += 1;

      if (decision.ticketCutoff !== null) {
        const counts = await this.purgeClosedTickets(
          tx,
          orgId,
          decision.projectId,
          decision.ticketCutoff,
          dryRun,
        );
        result.ticketsDeleted += counts.deleted;
        result.ticketsWouldDelete += counts.wouldDelete;
      }

      if (decision.attachmentCutoff !== null) {
        const counts = await this.purgeAttachments(
          tx,
          orgId,
          decision.projectId,
          decision.attachmentCutoff,
          dryRun,
          attachmentPurgeIds,
        );
        result.attachmentsDeleted += counts.deleted;
        result.attachmentsWouldDelete += counts.wouldDelete;
      }
    }
  }

  private async organizationHeld(tx: TenantTx, orgId: string): Promise<boolean> {
    const [held] = await tx
      .select({ holdId: organizationLegalHolds.holdId })
      .from(organizationLegalHolds)
      .where(
        and(
          eq(organizationLegalHolds.orgId, orgId),
          isNull(organizationLegalHolds.releasedAt),
        ),
      )
      .limit(1);
    return held !== undefined;
  }

  private async readSettings(
    tx: TenantTx,
    orgId: string,
  ): Promise<BuildRetentionSettingsRow[]> {
    const all: BuildRetentionSettingsRow[] = [];
    let after = 0;
    for (;;) {
      const page = await tx
        .select({
          id: projectRetentionSettings.id,
          projectId: projectRetentionSettings.projectId,
          inheritOrgPolicy: projectRetentionSettings.inheritOrgPolicy,
          closedTicketRetentionDays: projectRetentionSettings.closedTicketRetentionDays,
          attachmentRetentionDays: projectRetentionSettings.attachmentRetentionDays,
          legalHold: projectRetentionSettings.legalHold,
          legalHoldReason: projectRetentionSettings.legalHoldReason,
        })
        .from(projectRetentionSettings)
        .where(
          and(
            eq(projectRetentionSettings.orgId, orgId),
            gt(projectRetentionSettings.id, after),
          ),
        )
        .orderBy(asc(projectRetentionSettings.id))
        .limit(SETTINGS_PAGE_SIZE);

      for (const row of page) all.push(row);
      const last = page[page.length - 1];
      if (page.length < SETTINGS_PAGE_SIZE || last === undefined) break;
      after = last.id;
    }
    return all;
  }

  private async purgeClosedTickets(
    tx: TenantTx,
    orgId: string,
    projectId: number,
    cutoff: Date,
    dryRun: boolean,
  ): Promise<{ deleted: number; wouldDelete: number }> {
    const predicate = closedTicketPurgePredicate(orgId, projectId, cutoff);

    if (dryRun) {
      const [row] = await tx
        .select({ pending: count() })
        .from(tickets)
        .where(predicate)
        .limit(1);
      return { deleted: 0, wouldDelete: Number(row?.pending ?? 0) };
    }

    let deleted = 0;
    for (;;) {
      const batch = await tx
        .select({ id: tickets.id })
        .from(tickets)
        .where(predicate)
        .orderBy(asc(tickets.id))
        .limit(DELETE_BATCH_SIZE);
      if (batch.length === 0) break;

      const ids = batch.map((r) => r.id);
      await this.recordPurge(orgId, projectId, "closed_tickets", cutoff, ids);
      await tx
        .delete(tickets)
        .where(and(eq(tickets.orgId, orgId), inArray(tickets.id, ids)));

      deleted += ids.length;
      if (batch.length < DELETE_BATCH_SIZE) break;
    }
    return { deleted, wouldDelete: 0 };
  }

  private async purgeAttachments(
    tx: TenantTx,
    orgId: string,
    projectId: number,
    cutoff: Date,
    dryRun: boolean,
    attachmentPurgeIds: Map<string, Map<string, string>>,
  ): Promise<{ deleted: number; wouldDelete: number }> {
    const predicate = projectAttachmentPurgePredicate(orgId, projectId, cutoff);

    if (dryRun) {
      const [row] = await tx
        .select({ pending: count() })
        .from(projectAttachments)
        .where(predicate)
        .limit(1);
      return { deleted: 0, wouldDelete: Number(row?.pending ?? 0) };
    }

    let deleted = 0;
    for (;;) {
      const batch = await tx
        .select({ id: projectAttachments.id, storageKey: projectAttachments.storageKey })
        .from(projectAttachments)
        .where(predicate)
        .orderBy(asc(projectAttachments.id))
        .limit(DELETE_BATCH_SIZE);
      if (batch.length === 0) break;

      const ids = batch.map((r) => r.id);
      const keys = [...new Set(batch.map((r) => r.storageKey))];
      await tx
        .insert(storagePendingPurge)
        .values(
          keys.map((storageKey) => ({
            orgId,
            storageKey,
            purpose: BUILD_ATTACHMENT_PURGE_PURPOSE,
            bucket: "default" as const,
            status: "pending",
          })),
        )
        .onConflictDoUpdate({
          target: [storagePendingPurge.orgId, storagePendingPurge.storageKey],
          set: {
            purpose: BUILD_ATTACHMENT_PURGE_PURPOSE,
            bucket: "default",
            status: "pending",
            lastAttemptedAt: null,
            failedReason: null,
          },
        });
      const purgeIds = attachmentPurgeIds.get(orgId) ?? new Map<string, string>();
      for (const storageKey of keys) {
        const [purge] = await tx
          .select({ id: storagePendingPurge.id })
          .from(storagePendingPurge)
          .where(
            and(
              eq(storagePendingPurge.orgId, orgId),
              eq(storagePendingPurge.storageKey, storageKey),
            ),
          )
          .limit(1);
        if (!purge) throw new Error(`Pending purge row not found for ${storageKey}`);
        purgeIds.set(storageKey, purge.id);
      }
      attachmentPurgeIds.set(orgId, purgeIds);
      await this.recordPurge(orgId, projectId, "project_attachments", cutoff, ids);
      await tx
        .delete(projectAttachments)
        .where(
          and(eq(projectAttachments.orgId, orgId), inArray(projectAttachments.id, ids)),
        );

      deleted += ids.length;
      if (batch.length < DELETE_BATCH_SIZE) break;
    }
    return { deleted, wouldDelete: 0 };
  }

  private async deleteAttachmentObjects(
    attachmentPurgeIds: Map<string, Map<string, string>>,
  ): Promise<void> {
    for (const [orgId, keyToPurgeId] of attachmentPurgeIds) {
      for (const [storageKey, purgeId] of keyToPurgeId) {
        try {
          await this.storage.deleteFileIfPresent(orgId, storageKey, "default");
        } catch (error) {
          await this.pendingPurge
            .markFailed(orgId, purgeId, String(error).slice(0, 1_000))
            .catch(() => undefined);
          this.logger.error(
            `[${BUILD_PROJECT_RETENTION_SWEEP}] attachment object delete failed; pending purge retained`,
            { orgId, storageKey, error: String(error) },
          );
          continue;
        }

        await this.pendingPurge.markConfirmed(orgId, purgeId).catch((error) => {
          this.logger.error(
            `[${BUILD_PROJECT_RETENTION_SWEEP}] attachment purge confirmation failed; pending purge retained`,
            { orgId, storageKey, error: String(error) },
          );
        });
      }
    }
  }

  private async recordPurge(
    orgId: string,
    projectId: number,
    entity: BuildRetentionEntity,
    cutoff: Date,
    ids: readonly number[],
  ): Promise<void> {
    await this.audit.logCriticalOutsideTransaction({
      action: BUILD_PROJECT_RETENTION_AUDIT_ACTION,
      orgId,
      systemActor: BUILD_PROJECT_RETENTION_SWEEP,
      targetType: "project",
      targetId: String(projectId),
      resourceType: entity,
      result: "SUCCESS",
      metadata: {
        entity,
        projectId,
        cutoff: cutoff.toISOString(),
        purgedCount: ids.length,
        purgedIds: [...ids],
      },
    });
  }
}
