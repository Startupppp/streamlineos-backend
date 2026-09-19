import { Injectable, Inject } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lte, sql, sum } from "drizzle-orm";
import { z } from "zod";
import {
  leaveBalances,
  leaveTypes,
  hrBenefitEnrollments,
  hrBenefitPlans,
  hrEquityGrants,
  payslipPublications,
  payrollRuns,
  payrollRunEmployees,
  employeeSalaryProfiles,
  salaryLoans,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import {
  defineTool,
  data,
  empty,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "../registry/ask-os-tool.types";
import { buildTotalRewardsStatement } from "../../../payroll/insights/lib/total-rewards";

@Injectable()
export class SelfPayrollTools implements AskOsToolProvider {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "getMyPayslips",
        description:
          "Get the caller's published payslips, most recent first. Answers questions about net pay history.",
        input: z.object({}),
        permission: "self:payslips",
        module: "payroll",
        run: async (_input, ctx) => {
          const { orgId, membershipId } = ctx.actor;

          const pubs = await this.db
            .select({
              publicationId: payslipPublications.id,
              publishedAt: payslipPublications.publishedAt,
              month: payrollRuns.month,
              net: payrollRunEmployees.net,
            })
            .from(payslipPublications)
            .innerJoin(payrollRuns, eq(payrollRuns.id, payslipPublications.runId))
            .innerJoin(
              payrollRunEmployees,
              eq(payrollRunEmployees.id, payslipPublications.runEmployeeId),
            )
            .where(
              and(
                eq(payslipPublications.orgId, orgId),
                eq(payslipPublications.userMembershipId, membershipId),
                eq(payslipPublications.status, "PUBLISHED"),
              ),
            )
            .orderBy(desc(payslipPublications.publishedAt))
            .limit(100);

          if (pubs.length === 0) return empty("payslips", "No published payslips found.");

          return data(
            pubs.map((p) => ({
              publicationId: p.publicationId,
              month: p.month,
              net: p.net,
              publishedAt: p.publishedAt,
            })),
          );
        },
      }),

      defineTool({
        key: "getMyTotalRewards",
        description:
          "Get the caller's illustrative total rewards statement: salary CTC, year-to-date payslips, benefits, equity grants, and leave balances. Not a certified compensation statement.",
        input: z.object({}),
        permission: "self:payroll",
        module: "payroll",
        run: async (_input, ctx) => {
          const { orgId, userId, membershipId, currentYear, currentMonth } = ctx.actor;

          const fyStart =
            currentMonth >= 4 ? `${currentYear}-04` : `${currentYear - 1}-04`;
          const fyEnd =
            currentMonth >= 4 ? `${currentYear + 1}-03` : `${currentYear}-03`;

          const [profile, fyPubs, [activeLoanRow], benefitRows, equityRows, leaveRows] =
            await Promise.all([
              this.db.query.employeeSalaryProfiles.findFirst({
                where: and(
                  eq(employeeSalaryProfiles.orgId, orgId),
                  eq(employeeSalaryProfiles.userMembershipId, membershipId),
                  eq(employeeSalaryProfiles.status, "ACTIVE"),
                ),
                orderBy: (fields, { desc: d }) => [d(fields.effectiveFrom)],
              }),
              this.db
                .select({ runId: payslipPublications.runId })
                .from(payslipPublications)
                .innerJoin(payrollRuns, eq(payrollRuns.id, payslipPublications.runId))
                .where(
                  and(
                    eq(payslipPublications.orgId, orgId),
                    eq(payslipPublications.userMembershipId, membershipId),
                    eq(payslipPublications.status, "PUBLISHED"),
                    gte(payrollRuns.month, fyStart),
                    lte(payrollRuns.month, fyEnd),
                  ),
                ),
              this.db
                .select({
                  balance: sql<string>`coalesce(sum((coalesce(${salaryLoans.totalEmis}, 0) - coalesce(${salaryLoans.paidEmis}, 0)) * coalesce(${salaryLoans.emiAmount}, 0)::numeric), 0)::text`,
                })
                .from(salaryLoans)
                .where(
                  and(
                    eq(salaryLoans.orgId, orgId),
                    eq(salaryLoans.userMembershipId, membershipId),
                    inArray(salaryLoans.status, ["APPROVED", "ACTIVE"]),
                  ),
                ),
              this.db
                .select({
                  planName: hrBenefitPlans.name,
                  category: hrBenefitPlans.category,
                  premiumCents: hrBenefitPlans.premiumCents,
                  employerContributionPct: hrBenefitPlans.employerContributionPct,
                  status: hrBenefitEnrollments.status,
                })
                .from(hrBenefitEnrollments)
                .innerJoin(hrBenefitPlans, eq(hrBenefitPlans.id, hrBenefitEnrollments.planId))
                .where(
                  and(
                    eq(hrBenefitEnrollments.orgId, orgId),
                    eq(hrBenefitEnrollments.userId, userId),
                    eq(hrBenefitEnrollments.status, "active"),
                  ),
                )
                .limit(100),
              this.db
                .select({
                  grantType: hrEquityGrants.grantType,
                  units: hrEquityGrants.units,
                  strikePriceCents: hrEquityGrants.strikePriceCents,
                  status: hrEquityGrants.status,
                  grantDate: hrEquityGrants.grantDate,
                })
                .from(hrEquityGrants)
                .where(
                  and(
                    eq(hrEquityGrants.orgId, orgId),
                    eq(hrEquityGrants.userId, userId),
                    eq(hrEquityGrants.status, "active"),
                  ),
                )
                .limit(100),
              this.db
                .select({
                  leaveType: leaveTypes.name,
                  balance: leaveBalances.balance,
                })
                .from(leaveBalances)
                .leftJoin(leaveTypes, eq(leaveTypes.id, leaveBalances.leaveTypeId))
                .where(
                  and(
                    eq(leaveBalances.orgId, orgId),
                    eq(leaveBalances.userId, userId),
                    eq(leaveBalances.year, currentYear),
                  ),
                )
                .limit(100),
            ]);

          let ytdGross = 0;
          let ytdNet = 0;
          if (fyPubs.length > 0) {
            const [ytd] = await this.db
              .select({
                gross: sum(payrollRunEmployees.gross),
                net: sum(payrollRunEmployees.net),
              })
              .from(payrollRunEmployees)
              .where(
                and(
                  eq(payrollRunEmployees.userMembershipId, membershipId),
                  inArray(
                    payrollRunEmployees.runId,
                    fyPubs.map((p) => p.runId),
                  ),
                ),
              );
            ytdGross = parseFloat(ytd?.gross ?? "0") || 0;
            ytdNet = parseFloat(ytd?.net ?? "0") || 0;
          }

          const annualCtc =
            profile?.annualCtc != null ? parseFloat(profile.annualCtc) || null : null;

          return data(
            buildTotalRewardsStatement({
              cash: {
                annualCtc: annualCtc !== null && !Number.isNaN(annualCtc) ? annualCtc : null,
                ytdGross,
                ytdNet,
                activeLoanBalance: parseFloat(activeLoanRow?.balance ?? "0") || 0,
              },
              benefits: benefitRows.map((b) => ({
                planName: b.planName,
                category: String(b.category),
                premiumCents: b.premiumCents,
                employerContributionPct: b.employerContributionPct ?? 0,
                status: String(b.status),
              })),
              equity: equityRows.map((e) => ({
                grantType: String(e.grantType),
                units: e.units,
                strikePriceCents: e.strikePriceCents,
                status: String(e.status),
                grantDate: e.grantDate,
              })),
              leave: leaveRows.map((l) => ({
                leaveType: l.leaveType ?? "Leave",
                balance: parseFloat(String(l.balance ?? 0)) || 0,
              })),
            }),
          );
        },
      }),
    ];
  }
}
