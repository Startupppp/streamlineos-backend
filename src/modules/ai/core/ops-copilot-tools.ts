import { Injectable, Inject } from "@nestjs/common";
import { tool } from "ai";
import { z } from "zod";
import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import {
  invProducts,
  invProductVariants,
  invStockLevels,
  leaveBalances,
  leaveTypes,
  payrollRuns,
  payrollRunEmployees,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { ToolAccessService } from "./tool-access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";

export function shouldDenyTeamPayrollCopilot(scope: DataScope): boolean {
  return scope === "team";
}

const PAYROLL_COPILOT_BRANCH =
  "the payroll copilot answers a different shape per scope — self rows, a team refusal, or an org summary — rather than filtering one query";

export interface OpsCopilotContext {
  actor: CurrentUserContext;
}

@Injectable()
export class OpsCopilotTools {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly toolAccess: ToolAccessService,
  ) {}

  private async selfPayrollRows(
    orgId: string,
    userId: string,
    month?: string,
    year?: string,
  ) {
    return this.db
      .select({
        month: payrollRuns.month,
        status: payrollRunEmployees.status,
        netSalary: payrollRunEmployees.net,
      })
      .from(payrollRunEmployees)
      .innerJoin(payrollRuns, eq(payrollRunEmployees.runId, payrollRuns.id))
      .where(
        and(
          eq(payrollRuns.orgId, orgId),
          eq(payrollRunEmployees.userId, userId),
          month ? eq(payrollRuns.month, month) : undefined,
          year ? sql`${payrollRuns.month} LIKE ${year + "-%"}` : undefined,
        ),
      )
      .limit(12);
  }

  buildTools(ctx: OpsCopilotContext) {
    const { actor } = ctx;
    const { orgId, userId } = actor;

    return {
      getInventoryStock: tool({
        description:
          "Search for inventory products by name and show their current stock availability. Returns up to 5 matching products with on-hand, committed, and available quantities.",
        inputSchema: z.object({
          productQuery: z
            .string()
            .min(1)
            .describe("Partial product name to search for"),
        }),
        execute: async ({ productQuery }) => {
          const deny = await this.toolAccess.denyReason(
            orgId,
            userId,
            "inventory:products:read",
          );
          if (deny) return { denied: true, reason: deny };

          const stockDeny = await this.toolAccess.denyReason(
            orgId,
            userId,
            "inventory:stock:read",
          );
          if (stockDeny) return { denied: true, reason: stockDeny };

          const q = `%${productQuery.trim()}%`;
          const matched = await this.db
            .select({
              id: invProducts.id,
              name: invProducts.name,
              sku: invProducts.sku,
              status: invProducts.status,
            })
            .from(invProducts)
            .where(
              and(eq(invProducts.orgId, orgId), ilike(invProducts.name, q)),
            )
            .limit(5);

          if (matched.length === 0) {
            return {
              results: [],
              message: `No products found matching "${productQuery}".`,
            };
          }

          const productIds = matched.map((p) => p.id);
          const allVariants = await this.db
            .select({
              id: invProductVariants.id,
              name: invProductVariants.name,
              productId: invProductVariants.productId,
            })
            .from(invProductVariants)
            .where(inArray(invProductVariants.productId, productIds));

          const variantsByProduct = new Map<
            number,
            Array<{ id: number; name: string }>
          >();
          for (const v of allVariants) {
            const list = variantsByProduct.get(v.productId) ?? [];
            list.push({ id: v.id, name: v.name });
            variantsByProduct.set(v.productId, list);
          }

          const allVariantIds = allVariants.map((v) => v.id);
          const stockByVariant = new Map<
            number,
            { onHand: number; committed: number }
          >();
          if (allVariantIds.length > 0) {
            const stockRows = await this.db.execute<{
              variant_id: number;
              on_hand: string;
              committed: string;
            }>(sql`
              SELECT
                product_variant_id AS variant_id,
                COALESCE(SUM(on_hand::numeric), 0)::text AS on_hand,
                COALESCE(SUM(committed::numeric), 0)::text AS committed
              FROM ${invStockLevels}
              WHERE org_id = ${orgId}
                AND product_variant_id = ANY(ARRAY[${sql.join(
                  allVariantIds.map((id) => sql`${id}`),
                  sql`, `,
                )}]::int[])
              GROUP BY product_variant_id
            `);
            for (const r of stockRows)
              stockByVariant.set(Number(r.variant_id), {
                onHand: Number(r.on_hand),
                committed: Number(r.committed),
              });
          }

          const results = matched.map((product) => {
            const variants = (variantsByProduct.get(product.id) ?? []).slice(
              0,
              10,
            );
            if (variants.length === 0) return { ...product, stock: [] };
            return {
              ...product,
              stock: variants.map((v) => {
                const s = stockByVariant.get(v.id) ?? {
                  onHand: 0,
                  committed: 0,
                };
                return {
                  variantId: v.id,
                  variantName: v.name,
                  onHand: s.onHand,
                  committed: s.committed,
                  available: s.onHand - s.committed,
                };
              }),
            };
          });

          return { results };
        },
      }),

      getPayrollSummary: tool({
        description:
          "Get a payroll summary (counts and net totals by status). Never returns bank details or individual salaries when the user only has own-scope access. Use month (YYYY-MM) and/or year (YYYY) to filter.",
        inputSchema: z.object({
          month: z
            .string()
            .optional()
            .describe("Filter to a specific month, format YYYY-MM"),
          year: z
            .string()
            .optional()
            .describe("Filter to a specific year, format YYYY"),
        }),
        execute: async ({ month, year }) => {
          const read = await this.toolAccess.scope(
            orgId,
            userId,
            "hr:payroll:view",
          );
          const scope = read.rawScope(PAYROLL_COPILOT_BRANCH);

          if (read.denied) {
            const selfDeny = await this.toolAccess.denyReason(
              orgId,
              userId,
              "self:payslips",
            );
            if (selfDeny) return { denied: true, reason: selfDeny };
            return {
              scope: "self",
              records: await this.selfPayrollRows(orgId, userId, month, year),
            };
          }

          if (scope === "own") {
            return {
              scope: "self",
              records: await this.selfPayrollRows(orgId, userId, month, year),
            };
          }

          if (shouldDenyTeamPayrollCopilot(scope)) {
            return {
              denied: true,
              reason:
                "Team-scoped payroll summaries are not available in Ask OS yet. Open payroll reports for team totals.",
            };
          }

          const summaryRows = await this.db.execute<{
            status: string;
            count: string;
            total_net: string;
          }>(sql`
            SELECT
              pr.status,
              COUNT(pre.id) AS count,
              SUM(pre.net::numeric) AS total_net
            FROM payroll_run_employees pre
            JOIN payroll_runs pr ON pr.id = pre.run_id
            WHERE pr.org_id = ${orgId}
              ${month ? sql`AND pr.month = ${month}` : sql``}
              ${year && !month ? sql`AND pr.month LIKE ${year + "-%"}` : sql``}
            GROUP BY pr.status
            ORDER BY pr.status
          `);

          return {
            scope,
            byStatus: summaryRows.map((r) => ({
              status: String(r.status),
              count: Number(r.count),
              totalNet: Number(r.total_net ?? 0),
            })),
          };
        },
      }),

      getMyLeaveBalances: tool({
        description:
          "Get the current user's own leave balances for the current year, broken down by leave type.",
        inputSchema: z.object({}),
        execute: async () => {
          const currentYear = new Date().getFullYear();

          const rows = await this.db
            .select({
              leaveTypeName: leaveTypes.name,
              balance: leaveBalances.balance,
              daysPerYear: leaveTypes.daysPerYear,
            })
            .from(leaveBalances)
            .innerJoin(leaveTypes, eq(leaveBalances.leaveTypeId, leaveTypes.id))
            .where(
              and(
                eq(leaveBalances.orgId, orgId),
                eq(leaveBalances.userId, userId),
                eq(leaveBalances.year, currentYear),
              ),
            );

          if (rows.length === 0) {
            return {
              balances: [],
              message: "No leave balances found for the current year.",
            };
          }

          return {
            year: currentYear,
            balances: rows.map((r) => ({
              leaveType: r.leaveTypeName,
              balance: Number(r.balance),
              daysPerYear: r.daysPerYear,
            })),
          };
        },
      }),
    };
  }
}
