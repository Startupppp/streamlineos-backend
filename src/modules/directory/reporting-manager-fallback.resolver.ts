import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { DbOrTx } from "../../common/rbac/access-invalidate";
import { organizationMembers, users } from "../../db/schema";
import { ReportingLineService } from "./reporting-line.service";
import { ReportingManagerPolicyService } from "./reporting-manager-policy.service";
import { readReportingManagerPolicy } from "./reporting-line-queries";
import {
  REPORTING_LINE_ERROR_CODES as CODES,
  type ManagerAssignmentCheck,
  type ReportingActor,
  type ReportingLineErrorCode,
} from "./reporting-line.types";

export type ManagerResolution = "SELECTED" | "IN_FILE" | "FALLBACK_CONFIGURED" | "FALLBACK_UPLOADER";

export interface FallbackRow {
  /** Caller's key for the row, returned unchanged (a spreadsheet row number, say). */
  key: number;
  /** The employee, when they already exist — never picked as their own fallback. */
  employeeUserId?: string | null;
  /** The employee's email; another row may name it as its manager (`IN_FILE`). */
  employeeEmail?: string | null;
  primaryManagerUserId?: string | null;
  primaryManagerEmail?: string | null;
}

export type FallbackResult =
  | {
      key: number;
      ok: true;
      /** Null only for `IN_FILE` rows whose manager is another, not-yet-created row. */
      managerUserId: string | null;
      managerEmploymentId: number | null;
      name: string | null;
      email: string | null;
      resolution: ManagerResolution;
      dependsOnRow: number | null;
    }
  | { key: number; ok: false; code: ReportingLineErrorCode; message: string };

interface Member {
  userId: string;
  email: string;
  name: string;
}

function normalEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

@Injectable()
export class ReportingManagerFallbackResolver {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly reportingLines: ReportingLineService,
    private readonly policies: ReportingManagerPolicyService,
  ) {}

  /**
   * PRD D2, exactly: a valid supplied manager wins; otherwise the policy's order decides between
   * the configured default and the acting administrator; otherwise the row is refused with
   * NO_DEFAULT_REPORTING_MANAGER. A supplied manager that is invalid is refused, never replaced by
   * a fallback. One preload serves the whole batch: policy, members by id and email, eligibility.
   */
  async resolveMany(orgId: string, actor: ReportingActor, rows: readonly FallbackRow[], db: DbOrTx = this.db): Promise<FallbackResult[]> {
    const policy = await readReportingManagerPolicy(db, orgId);
    const actorUserId = "system" in actor ? null : actor.userId;
    const ids = new Set<string>();
    const emails = new Set<string>();
    for (const row of rows) {
      if (row.primaryManagerUserId) ids.add(row.primaryManagerUserId);
      const email = normalEmail(row.primaryManagerEmail);
      if (email) emails.add(email);
    }
    if (policy.defaultPrimaryManagerUserId) ids.add(policy.defaultPrimaryManagerUserId);
    if (actorUserId) ids.add(actorUserId);

    const members = await this.membersOf(orgId, [...ids], [...emails], db);
    const byId = new Map(members.map((member) => [member.userId, member]));
    const byEmail = new Map(members.map((member) => [member.email, member]));
    const checks = await this.reportingLines.checkManagers(orgId, members.map((member) => member.userId), db);
    const actorQualifies = actorUserId !== null && checks.get(actorUserId)?.ok === true && (await this.policies.isElevated(actor));

    const rowByEmployeeEmail = new Map<string, number>();
    for (const row of rows) {
      const email = normalEmail(row.employeeEmail);
      if (email && !rowByEmployeeEmail.has(email)) rowByEmployeeEmail.set(email, row.key);
    }

    const isSelf = (row: FallbackRow, member: Member): boolean =>
      member.userId === row.employeeUserId || member.email === normalEmail(row.employeeEmail);

    const chosen = (row: FallbackRow, member: Member, resolution: ManagerResolution): FallbackResult => {
      const check = checks.get(member.userId);
      if (isSelf(row, member)) return { key: row.key, ok: false, code: CODES.SELF_REFERENCE, message: "An employee cannot report to themselves." };
      if (!check?.ok) return refusal(row.key, check);
      return {
        key: row.key,
        ok: true,
        managerUserId: member.userId,
        managerEmploymentId: check.managerEmploymentId,
        name: member.name,
        email: member.email,
        resolution,
        dependsOnRow: null,
      };
    };

    return rows.map((row): FallbackResult => {
      const email = normalEmail(row.primaryManagerEmail);
      if (row.primaryManagerUserId) {
        const member = byId.get(row.primaryManagerUserId);
        if (email && member && member.email !== email)
          return { key: row.key, ok: false, code: CODES.MANAGER_COLUMN_CONFLICT, message: "The manager id and the manager email name different people." };
        if (!member) return { key: row.key, ok: false, code: CODES.MANAGER_NOT_FOUND, message: "The selected manager is not an active member of this organization." };
        return chosen(row, member, "SELECTED");
      }
      if (email) {
        const member = byEmail.get(email);
        if (member) return chosen(row, member, "IN_FILE");
        if (email === normalEmail(row.employeeEmail))
          return { key: row.key, ok: false, code: CODES.SELF_REFERENCE, message: "An employee cannot report to themselves." };
        const dependsOnRow = rowByEmployeeEmail.get(email);
        if (dependsOnRow !== undefined)
          return { key: row.key, ok: true, managerUserId: null, managerEmploymentId: null, name: null, email, resolution: "IN_FILE", dependsOnRow };
        return { key: row.key, ok: false, code: CODES.MANAGER_NOT_FOUND, message: `No active member of this organization has the email ${email}.` };
      }

      const configured = policy.defaultPrimaryManagerUserId ? byId.get(policy.defaultPrimaryManagerUserId) : undefined;
      const uploader = actorQualifies && actorUserId ? byId.get(actorUserId) : undefined;
      const order: Array<[Member | undefined, ManagerResolution]> =
        policy.fallbackOrder === "CONFIGURED_MANAGER_THEN_UPLOADER"
          ? [[configured, "FALLBACK_CONFIGURED"], [uploader, "FALLBACK_UPLOADER"]]
          : [[uploader, "FALLBACK_UPLOADER"], [configured, "FALLBACK_CONFIGURED"]];
      for (const [member, resolution] of order) {
        if (!member || isSelf(row, member) || checks.get(member.userId)?.ok !== true) continue;
        return chosen(row, member, resolution);
      }
      return {
        key: row.key,
        ok: false,
        code: CODES.NO_DEFAULT_REPORTING_MANAGER,
        message: "No reporting manager was given and the organization has no eligible default reporting manager. Choose a manager, or set a default in the reporting manager policy.",
      };
    });
  }

  async resolve(orgId: string, actor: ReportingActor, row: FallbackRow, db: DbOrTx = this.db): Promise<FallbackResult> {
    const [result] = await this.resolveMany(orgId, actor, [row], db);
    return result;
  }

  /** Whether the actor would be used as the uploader fallback (the policy page's `actorQualifiesAsFallback`). */
  async actorQualifiesAsFallback(orgId: string, actor: ReportingActor, db: DbOrTx = this.db): Promise<boolean> {
    if ("system" in actor) return false;
    const check = await this.reportingLines.checkManager(orgId, actor.userId, db);
    return check.ok && (await this.policies.isElevated(actor));
  }

  private async membersOf(orgId: string, userIds: readonly string[], emails: readonly string[], db: DbOrTx): Promise<Member[]> {
    if (userIds.length === 0 && emails.length === 0) return [];
    const email = sql<string>`lower(${users.email})`;
    const matches = [
      ...(userIds.length > 0 ? [inArray(organizationMembers.userId, [...userIds])] : []),
      ...(emails.length > 0 ? [inArray(email, [...emails])] : []),
    ];
    return db
      .select({
        userId: organizationMembers.userId,
        email,
        name: sql<string>`coalesce(nullif(trim(${users.name}), ''), nullif(trim(concat_ws(' ', ${users.firstName}, ${users.lastName})), ''), ${users.email})`,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, orgId), or(...matches)));
  }
}

function refusal(key: number, check: ManagerAssignmentCheck | undefined): FallbackResult {
  if (!check || check.ok || check.reason === "manager-not-in-organization")
    return { key, ok: false, code: CODES.MANAGER_NOT_FOUND, message: "The selected manager is not an active member of this organization." };
  if (check.reason === "self-reference") return { key, ok: false, code: CODES.SELF_REFERENCE, message: check.message };
  return { key, ok: false, code: CODES.MANAGER_NOT_ELIGIBLE, message: check.message };
}
