import { and, eq, gte, lte, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { organizationMembers, timesheets, users } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ExportWorkLogsQuery } from "./dto/work-logs.schemas";
import { resolveWorkLogsScope } from "./worklogs-scope";

export async function exportWorkLogsCsv(
  db: Db,
  access: AccessService,
  audit: AuditService,
  u: CurrentUserContext,
  query: ExportWorkLogsQuery,
): Promise<string> {
  const scope = await resolveWorkLogsScope(access, u);

  const conditions: SQL[] = [eq(timesheets.orgId, u.orgId)];

  if (scope !== "all") {
    const [selfMember] = await db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.userId, u.userId)))
      .limit(1);
    if (selfMember) conditions.push(eq(timesheets.userMembershipId, selfMember.id));
  } else if (query.userId) {
    const [qMember] = await db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.userId, query.userId)))
      .limit(1);
    if (qMember) conditions.push(eq(timesheets.userMembershipId, qMember.id));
  }

  if (query.startDate) conditions.push(gte(timesheets.date, query.startDate));
  if (query.endDate) conditions.push(lte(timesheets.date, query.endDate));

  const exportMember = alias(organizationMembers, "export_member");
  const data = await db
    .select({
      date: timesheets.date,
      hours: timesheets.hours,
      description: timesheets.description,
      status: timesheets.status,
      userName: users.name,
      userEmail: users.email,
    })
    .from(timesheets)
    .leftJoin(exportMember, and(eq(timesheets.orgId, exportMember.orgId), eq(timesheets.userMembershipId, exportMember.id)))
    .leftJoin(users, eq(exportMember.userId, users.id))
    .where(and(...conditions))
    .orderBy(timesheets.date)
    .limit(5000);

  const headers = ["Date", "Employee", "Email", "Hours", "Description", "Status"];
  const rows = data.map((r) => [
    r.date,
    r.userName || "",
    r.userEmail || "",
    r.hours || "0",
    r.description || "",
    r.status || "PENDING",
  ]);

  const csv = [headers, ...rows]
    .map((row) => row.map((val) => `"${String(val ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");

  await audit.logCritical({
    action: "worklog.exported",
    userId: u.userId,
    orgId: u.orgId,
    metadata: {
      format: "csv",
      recordCount: rows.length,
      startDate: query.startDate ?? null,
      endDate: query.endDate ?? null,
    },
  });

  return csv;
}
