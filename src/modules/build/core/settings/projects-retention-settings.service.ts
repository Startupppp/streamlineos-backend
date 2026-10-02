import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { projectRetentionSettings } from "../../../../db/schema";
import { AccessService } from "../../../access/access.service";
import { assertCanManageProject, assertProjectVisible } from "../project-crud/project-access";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type {
  UpdateRetentionPolicyInput,
  SetLegalHoldInput,
  ProjectRetentionSettingsRow,
  RetentionDaysPreset,
} from "../dto/project-retention-settings.schemas";
import { isRetentionDaysPreset } from "../dto/project-retention-settings.schemas";

function nowIso(): string {
  return new Date().toISOString();
}

function toRetentionPreset(v: number | null): RetentionDaysPreset | null {
  if (v === null) return null;
  if (isRetentionDaysPreset(v)) return v;
  throw new Error(`Unexpected retention days value: ${v}`);
}

const DEFAULT_PROJECTION = {
  inheritOrgPolicy: projectRetentionSettings.inheritOrgPolicy,
  closedTicketRetentionDays: projectRetentionSettings.closedTicketRetentionDays,
  attachmentRetentionDays: projectRetentionSettings.attachmentRetentionDays,
  auditLogRetentionDays: projectRetentionSettings.auditLogRetentionDays,
  legalHold: projectRetentionSettings.legalHold,
  legalHoldReason: projectRetentionSettings.legalHoldReason,
  legalHoldSetAt: projectRetentionSettings.legalHoldSetAt,
  version: projectRetentionSettings.version,
  updatedAt: projectRetentionSettings.updatedAt,
};

type SettingsRow = {
  inheritOrgPolicy: boolean;
  closedTicketRetentionDays: number | null;
  attachmentRetentionDays: number | null;
  auditLogRetentionDays: number | null;
  legalHold: boolean;
  legalHoldReason: string | null;
  legalHoldSetAt: Date | null;
  version: number;
  updatedAt: Date;
};

function toResponse(projectId: number, row: SettingsRow): ProjectRetentionSettingsRow {
  return {
    projectId,
    inheritOrgPolicy: row.inheritOrgPolicy,
    closedTicketRetentionDays: toRetentionPreset(row.closedTicketRetentionDays),
    attachmentRetentionDays: toRetentionPreset(row.attachmentRetentionDays),
    auditLogRetentionDays: toRetentionPreset(row.auditLogRetentionDays),
    legalHold: row.legalHold,
    legalHoldReason: row.legalHoldReason,
    legalHoldSetAt: row.legalHoldSetAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class ProjectsRetentionSettingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async getSettings(
    u: CurrentUserContext,
    projectId: number,
  ): Promise<ProjectRetentionSettingsRow> {
    await assertProjectVisible(this.db, this.access, u, projectId);

    const [row] = await this.db
      .select(DEFAULT_PROJECTION)
      .from(projectRetentionSettings)
      .where(
        and(
          eq(projectRetentionSettings.orgId, u.orgId),
          eq(projectRetentionSettings.projectId, projectId),
        ),
      )
      .limit(1);

    if (!row) {
      return {
        projectId,
        inheritOrgPolicy: true,
        closedTicketRetentionDays: null,
        attachmentRetentionDays: null,
        auditLogRetentionDays: null,
        legalHold: false,
        legalHoldReason: null,
        legalHoldSetAt: null,
        version: 0,
        updatedAt: nowIso(),
      };
    }

    return toResponse(projectId, row);
  }

  async updatePolicy(
    u: CurrentUserContext,
    projectId: number,
    input: UpdateRetentionPolicyInput,
  ): Promise<ProjectRetentionSettingsRow> {
    await assertCanManageProject(this.db, this.access, u, projectId);

    const [existing] = await this.db
      .select({ id: projectRetentionSettings.id, version: projectRetentionSettings.version })
      .from(projectRetentionSettings)
      .where(
        and(
          eq(projectRetentionSettings.orgId, u.orgId),
          eq(projectRetentionSettings.projectId, projectId),
        ),
      )
      .limit(1);

    const now = new Date();
    let row: SettingsRow | undefined;

    if (existing) {
      const [updated] = await this.db
        .update(projectRetentionSettings)
        .set({
          inheritOrgPolicy: input.inheritOrgPolicy,
          closedTicketRetentionDays: input.closedTicketRetentionDays,
          attachmentRetentionDays: input.attachmentRetentionDays,
          auditLogRetentionDays: input.auditLogRetentionDays,
          version: existing.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(projectRetentionSettings.orgId, u.orgId),
            eq(projectRetentionSettings.projectId, projectId),
          ),
        )
        .returning(DEFAULT_PROJECTION);
      row = updated;
    } else {
      const [inserted] = await this.db
        .insert(projectRetentionSettings)
        .values({
          orgId: u.orgId,
          projectId,
          inheritOrgPolicy: input.inheritOrgPolicy,
          closedTicketRetentionDays: input.closedTicketRetentionDays,
          attachmentRetentionDays: input.attachmentRetentionDays,
          auditLogRetentionDays: input.auditLogRetentionDays,
          legalHold: false,
          version: 1,
          updatedAt: now,
        })
        .returning(DEFAULT_PROJECTION);
      row = inserted;
    }

    if (!row) throw new ConflictException("Retention policy update produced no result");

    return toResponse(projectId, row);
  }

  async setLegalHold(
    u: CurrentUserContext,
    projectId: number,
    input: SetLegalHoldInput,
  ): Promise<void> {
    await assertCanManageProject(this.db, this.access, u, projectId);

    const [existing] = await this.db
      .select({ id: projectRetentionSettings.id, version: projectRetentionSettings.version })
      .from(projectRetentionSettings)
      .where(
        and(
          eq(projectRetentionSettings.orgId, u.orgId),
          eq(projectRetentionSettings.projectId, projectId),
        ),
      )
      .limit(1);

    const now = new Date();
    const holdFields = input.active
      ? {
          legalHold: true,
          legalHoldReason: input.reason ?? null,
          legalHoldSetAt: now,
        }
      : {
          legalHold: false,
          legalHoldReason: null,
          legalHoldSetAt: null,
        };

    if (existing) {
      await this.db
        .update(projectRetentionSettings)
        .set({ ...holdFields, version: existing.version + 1, updatedAt: now })
        .where(
          and(
            eq(projectRetentionSettings.orgId, u.orgId),
            eq(projectRetentionSettings.projectId, projectId),
          ),
        );
    } else {
      await this.db.insert(projectRetentionSettings).values({
        orgId: u.orgId,
        projectId,
        inheritOrgPolicy: true,
        ...holdFields,
        version: 1,
        updatedAt: now,
      });
    }
  }
}
