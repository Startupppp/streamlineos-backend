import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import {
  attendance,
  deals,
  leaveRequests,
  payrollRuns,
  payrollRunEmployees,
} from "../../../../db/schema";
import { businessParties, leadPartyMap } from "../../../../db/schema/party";
import { getTodayString } from "../../../../common/date";
import { type Db } from "../../../../db/drizzle.module";
import {
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadPartyScope,
} from "../../../leads/lead-party-reader";
import type { ChatContext } from "./chat-assistant-model";
import { resolveAskOsActor, type AskOsActor } from "./ask-os-actor";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

export interface ChatTurnContext {
  context: ChatContext;
  actor: AskOsActor;
}

export async function fetchChatContext(
  db: Db,
  userId: string,
  orgId: string,
  caller: CurrentUserContext,
): Promise<ChatTurnContext> {
  const today = getTodayString();

  const [
    askOsActor,
    todayAttendance,
    pendingLeaves,
    recentPayrolls,
    myLeadsResult,
    myOpenDealsResult,
    topLeads,
  ] = await Promise.all([
    resolveAskOsActor(db, caller),
    db.query.attendance.findFirst({
      columns: { checkIn: true, checkOut: true, workHours: true },
      where: and(
        eq(attendance.userId, userId),
        eq(attendance.date, today),
        eq(attendance.orgId, orgId),
      ),
    }),
    db
      .select({ count: count() })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.userId, userId),
          eq(leaveRequests.status, "PENDING"),
          eq(leaveRequests.orgId, orgId),
        ),
      ),
    db
      .select({
        month: payrollRuns.month,
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
      .from(leadPartyMap)
      .innerJoin(businessParties, LEAD_PARTY_JOIN)
      .where(
        and(
          ...leadPartyScope(orgId),
          eq(LEAD_PARTY_COLUMNS.assignedToId, userId),
        ),
      ),
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
        name: LEAD_PARTY_COLUMNS.name,
        status: LEAD_PARTY_COLUMNS.status,
        priority: LEAD_PARTY_COLUMNS.priority,
      })
      .from(leadPartyMap)
      .innerJoin(businessParties, LEAD_PARTY_JOIN)
      .where(
        and(
          ...leadPartyScope(orgId),
          eq(LEAD_PARTY_COLUMNS.assignedToId, userId),
        ),
      )
      // `created_at` is not unique; the id decides which five, rather than the heap.
      .orderBy(desc(LEAD_PARTY_COLUMNS.createdAt), desc(LEAD_PARTY_COLUMNS.id))
      .limit(5),
  ]);

  return {
    actor: askOsActor,
    context: {
    todayAttendance: todayAttendance
      ? {
          checkedIn: Boolean(todayAttendance.checkIn),
          checkedOut: Boolean(todayAttendance.checkOut),
          workHours: todayAttendance.workHours,
        }
      : null,
    pendingLeaves: pendingLeaves[0]?.count ?? 0,
    recentPayrolls: recentPayrolls.map((p) => ({
      month: p.month,
      status: p.status || "UNKNOWN",
    })),
    myLeadsCount: myLeadsResult[0]?.count ?? 0,
    myOpenDealsCount: myOpenDealsResult[0]?.count ?? 0,
    topLeads,
    },
  };
}
