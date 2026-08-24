import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import {
  attendance,
  deals,
  leads,
  leaveRequests,
  payrollRuns,
  payrollRunEmployees,
  projects,
  tickets,
} from "../../../../db/schema";
import { getTodayString } from "../../../../common/date";
import { type Db } from "../../../../db/drizzle.module";
import type { ChatContext } from "./chat-assistant-model";

export async function fetchChatContext(
  db: Db,
  userId: string,
  orgId: string,
): Promise<ChatContext> {
  const today = getTodayString();

  const [
    projectCount,
    ticketCount,
    todayAttendance,
    pendingLeaves,
    recentPayrolls,
    myLeadsResult,
    hotLeadsResult,
    myOpenDealsResult,
    topLeads,
  ] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt))),
    db
      .select({ count: sql<number>`count(*)` })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt))),
    db.query.attendance.findFirst({
      where: and(
        eq(attendance.userId, userId),
        eq(attendance.date, today),
        eq(attendance.orgId, orgId),
      ),
    }),
    db.query.leaveRequests.findMany({
      where: and(
        eq(leaveRequests.userId, userId),
        eq(leaveRequests.status, "PENDING"),
        eq(leaveRequests.orgId, orgId),
      ),
      limit: 5,
    }),
    db
      .select({
        month: payrollRuns.month,
        netSalary: payrollRunEmployees.net,
        status: payrollRunEmployees.status,
      })
      .from(payrollRunEmployees)
      .innerJoin(payrollRuns, eq(payrollRunEmployees.runId, payrollRuns.id))
      .where(
        and(
          eq(payrollRunEmployees.userId, userId),
          eq(payrollRuns.orgId, orgId),
        ),
      )
      .orderBy(desc(payrollRuns.createdAt))
      .limit(3),
    db
      .select({ count: count() })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), eq(leads.assignedToId, userId))),
    db
      .select({ count: count() })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), eq(leads.priority, "HOT"))),
    db
      .select({ count: count() })
      .from(deals)
      .where(
        and(
          eq(deals.orgId, orgId),
          isNull(deals.deletedAt),
          eq(deals.assignedToId, userId),
          sql`${deals.stage} NOT IN ('WON', 'LOST')`,
        ),
      ),
    db
      .select({
        name: leads.name,
        status: leads.status,
        priority: leads.priority,
      })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), eq(leads.assignedToId, userId)))
      .orderBy(desc(leads.createdAt))
      .limit(5),
  ]);

  return {
    projectCount: projectCount[0]?.count || 0,
    ticketCount: ticketCount[0]?.count || 0,
    todayAttendance: todayAttendance
      ? {
          checkedIn: Boolean(todayAttendance.checkIn),
          checkedOut: Boolean(todayAttendance.checkOut),
          workHours: todayAttendance.workHours,
        }
      : null,
    pendingLeaves: pendingLeaves.length,
    recentPayrolls: recentPayrolls.map((p) => ({
      month: p.month,
      netSalary: p.netSalary,
      status: p.status || "UNKNOWN",
    })),
    myLeadsCount: myLeadsResult[0]?.count ?? 0,
    hotLeadsCount: hotLeadsResult[0]?.count ?? 0,
    myOpenDealsCount: myOpenDealsResult[0]?.count ?? 0,
    topLeads,
  };
}
