import { Injectable, Inject } from "@nestjs/common";
import { z } from "zod";
import { and, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import {
  invProducts,
  invProductVariants,
  leaveBalances,
  leaveTypes,
  payrollRuns,
  payrollRunEmployees,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { availableQtySumSql } from "../../inventory/stock-engine/available-sql";
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../../inventory/stock-engine/warehouse-scope.service";
import type { DataScope } from "../../access/access.types";
import {
  defineTool,
  data,
  denied,
  empty,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "./registry/ask-os-tool.types";

export function shouldDenyTeamPayrollCopilot(scope: DataScope): boolean {
  return scope === "team";
}

const LEAVE_BALANCE_CAP = 50;

const STOCK_LOOKUP_CAPS = { products: 5, variants: 10, variantScan: 500 } as const;

export interface CopilotStockRow {
  variantId: number;
  onHand: number;
  committed: number;
  available: number;
}

export async function readCopilotVariantStock(
  db: Db,
  orgId: string,
  scope: ResolvedWarehouseScope,
  variantIds: readonly number[],
): Promise<CopilotStockRow[]> {
  if (variantIds.length === 0 || scope.isEmpty) return [];

  const rows = await db.execute<{
    variant_id: number;
    on_hand: string;
    committed: string;
    available: string;
  }>(sql`
    SELECT
      product_variant_id AS variant_id,
      COALESCE(SUM(on_hand::numeric), 0)::text AS on_hand,
      COALESCE(SUM(committed::numeric), 0)::text AS committed,
      ${availableQtySumSql("inv_stock_levels")}::text AS available
    FROM inv_stock_levels
    WHERE org_id = ${orgId}
      AND product_variant_id = ANY(${sql`ARRAY[${sql.join(
        variantIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::int[]`})
      AND ${scope.location("inv_stock_levels.location_id")}
    GROUP BY product_variant_id
  `);

  return rows.map((row) => ({
    variantId: Number(row.variant_id),
    onHand: Number(row.on_hand),
    committed: Number(row.committed),
    available: Number(row.available),
  }));
}

@Injectable()
export class OpsCopilotTools implements AskOsToolProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
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

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "getInventoryStock",
        description:
          "Search for inventory products by name and show their current stock availability. Returns up to 5 matching products with on-hand, committed, and available quantities.",
        input: z.object({
          productQuery: z.string().min(1).max(120).describe("Partial product name to search for"),
        }),
        permission: "inventory:products:read",
        module: "inventory",
        run: async ({ productQuery }, ctx) => {
          const stockScope = ctx.scopes["inventory:stock:read"];
          if (!stockScope || stockScope === "none")
            return denied("inventory:stock:read");

          const scope = await this.warehouseScope.forUser(ctx.actor.orgId, ctx.actor.userId);

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
              and(
                eq(invProducts.orgId, ctx.actor.orgId),
                isNull(invProducts.deletedAt),
                ilike(invProducts.name, q),
              ),
            )
            .limit(STOCK_LOOKUP_CAPS.products);

          if (matched.length === 0)
            return empty("products", `No product matches "${productQuery}".`);

          const productIds = matched.map((p) => p.id);
          const allVariants = await this.db
            .select({
              id: invProductVariants.id,
              name: invProductVariants.name,
              productId: invProductVariants.productId,
            })
            .from(invProductVariants)
            .where(
              and(
                eq(invProductVariants.orgId, ctx.actor.orgId),
                inArray(invProductVariants.productId, productIds),
                isNull(invProductVariants.deletedAt),
              ),
            )
            .orderBy(invProductVariants.productId, invProductVariants.id)
            .limit(STOCK_LOOKUP_CAPS.variantScan);

          const variantsByProduct = new Map<number, Array<{ id: number; name: string }>>();
          for (const v of allVariants) {
            const list = variantsByProduct.get(v.productId) ?? [];
            list.push({ id: v.id, name: v.name });
            variantsByProduct.set(v.productId, list);
          }

          const shown = matched.map((product) => ({
            product,
            variants: (variantsByProduct.get(product.id) ?? []).slice(0, STOCK_LOOKUP_CAPS.variants),
          }));
          const stockRows = await readCopilotVariantStock(
            this.db,
            ctx.actor.orgId,
            scope,
            shown.flatMap((entry) => entry.variants.map((v) => v.id)),
          );
          const stockByVariant = new Map(stockRows.map((r) => [r.variantId, r]));

          const results = shown.map(({ product, variants }) => {
            if (variants.length === 0) return { ...product, stock: [] };
            return {
              ...product,
              stock: variants.map((v) => {
                const s = stockByVariant.get(v.id) ?? { onHand: 0, committed: 0, available: 0 };
                return {
                  variantId: v.id,
                  variantName: v.name,
                  onHand: s.onHand,
                  committed: s.committed,
                  available: s.available,
                };
              }),
            };
          });

          return data({ results });
        },
      }),

      defineTool({
        key: "getPayrollSummary",
        description:
          "Get a payroll summary (counts and net totals by status). Never returns bank details or individual salaries when the user only has own-scope access. Use month (YYYY-MM) and/or year (YYYY) to filter.",
        input: z.object({
          month: z.string().optional().describe("Filter to a specific month, format YYYY-MM"),
          year: z.string().optional().describe("Filter to a specific year, format YYYY"),
        }),
        permission: "self:payslips",
        module: "payroll",
        run: async ({ month, year }, ctx) => {
          const hrPayrollScope = ctx.scopes["hr:payroll:view"];

          if (hrPayrollScope === "all") {
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
              WHERE pr.org_id = ${ctx.actor.orgId}
                ${month ? sql`AND pr.month = ${month}` : sql``}
                ${year && !month ? sql`AND pr.month LIKE ${year + "-%"}` : sql``}
              GROUP BY pr.status
              ORDER BY pr.status
            `);
            return data({
              scope: hrPayrollScope,
              byStatus: summaryRows.map((r) => ({
                status: String(r.status),
                count: Number(r.count),
                totalNet: Number(r.total_net ?? 0),
              })),
            });
          }

          if (shouldDenyTeamPayrollCopilot(hrPayrollScope)) {
            return empty(
              "team payroll summary",
              "Team-scoped payroll summaries are not available in Ask OS. Open payroll reports for team totals.",
            );
          }

          if (hrPayrollScope === "own") {
            return data({
              scope: "self",
              records: await this.selfPayrollRows(ctx.actor.orgId, ctx.actor.userId, month, year),
            });
          }

          const selfScope = ctx.scopes["self:payslips"];
          if (!selfScope || selfScope === "none")
            return denied("self:payslips");

          return data({
            scope: "self",
            records: await this.selfPayrollRows(ctx.actor.orgId, ctx.actor.userId, month, year),
          });
        },
      }),

      defineTool({
        key: "getMyLeaveBalances",
        description:
          "Get the current user's own leave balances for the current year, broken down by leave type.",
        input: z.object({}),
        permission: "self:leaves",
        run: async (_input, ctx) => {
          const currentYear = new Date().getFullYear();

          const rows = await this.db
            .select({
              leaveTypeId: leaveTypes.id,
              leaveTypeName: leaveTypes.name,
              balance: leaveBalances.balance,
              daysPerYear: leaveTypes.daysPerYear,
            })
            .from(leaveBalances)
            .innerJoin(leaveTypes, eq(leaveBalances.leaveTypeId, leaveTypes.id))
            .where(
              and(
                eq(leaveBalances.orgId, ctx.actor.orgId),
                eq(leaveBalances.userId, ctx.actor.userId),
                eq(leaveBalances.year, currentYear),
              ),
            )
            .limit(LEAVE_BALANCE_CAP);

          if (rows.length === 0) return empty("leave balances");

          return data({
            year: currentYear,
            balances: rows.map((r) => ({
              leaveTypeId: r.leaveTypeId,
              leaveType: r.leaveTypeName,
              balance: Number(r.balance),
              daysPerYear: r.daysPerYear,
            })),
          });
        },
      }),
    ];
  }
}
