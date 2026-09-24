import { Injectable, Inject } from "@nestjs/common";
import { z } from "zod";
import { and, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import {
  invProducts,
  invProductVariants,
  leaveBalances,
  leaveTypes,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { WarehouseScopeService } from "../../../inventory/stock-engine/warehouse-scope.service";
import {
  defineTool,
  data,
  denied,
  empty,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";
import { readCopilotVariantStock } from "./lib/ops-copilot-reads";
import { VARIANT_SCAN_CAP } from "./lib/tool-read-caps";

const LEAVE_BALANCE_CAP = 50;

const STOCK_LOOKUP_CAPS = { products: 5, variants: 10, variantScan: VARIANT_SCAN_CAP } as const;

@AskOsTools()
@Injectable()
export class OpsCopilotTools implements AskOsToolProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

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
          if (ctx.readFor("inventory:stock:read").denied)
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
        key: "getOrgPayrollSummary",
        description:
          "Get the organisation-wide payroll summary: run counts and net totals grouped by run status. Requires organisation-wide payroll visibility, and returns no bank details or individual salaries. Use month (YYYY-MM) and/or year (YYYY) to filter. For the caller's own pay history use getMyPayslips instead.",
        input: z.object({
          month: z.string().optional().describe("Filter to a specific month, format YYYY-MM"),
          year: z.string().optional().describe("Filter to a specific year, format YYYY"),
        }),
        permission: "hr:payroll:view",
        module: "payroll",
        run: async ({ month, year }, ctx) => {
          if (!ctx.read.unrestricted) return denied("hr:payroll:view");

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
            scope: "organization",
            byStatus: summaryRows.map((r) => ({
              status: String(r.status),
              count: Number(r.count),
              totalNet: Number(r.total_net ?? 0),
            })),
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
          const currentYear = ctx.actor.currentYear;

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
