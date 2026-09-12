import { Injectable, Inject } from "@nestjs/common";
import { tool } from "ai";
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

/**
 * Caps on what one lookup may pull into a context window. `variantScan` bounds
 * the single batched variant read across every matched product; `variants` is
 * what each product then shows.
 */
const STOCK_LOOKUP_CAPS = { products: 5, variants: 10, variantScan: 500 } as const;

export interface CopilotStockRow {
  variantId: number;
  onHand: number;
  committed: number;
  available: number;
}

/**
 * F2 — stock quantities for a set of variants, scoped to the asker's warehouses.
 *
 * Two rules from backend/CLAUDE.md §4 meet in this one query, and both used to
 * be missing here.
 *
 * The first is that a chunk is disclosed the moment it enters the context
 * window, so the copilot must bind **the same object-level visibility the direct
 * read endpoint enforces**, in the SQL predicate. `inv-stock.service`,
 * `inv-stock-reservations.service` and the inventory reports all resolve
 * `WarehouseScopeService` and put it in their `WHERE`; this tool did not, so an
 * operator assigned to one warehouse could read every site's stock by asking the
 * assistant instead of opening the screen it is a second door onto. The scope is
 * now the same service's predicate, not a paraphrase of it.
 *
 * The second is that `available` has exactly one definition. A1 collapsed eight
 * hand-written copies of the subtraction, one of them here, where it read
 * `onHand - committed` — two terms of five, quietly offering blocked stock,
 * quality-held stock, picked-and-waiting stock, and goods standing in a van at a
 * transit location. A copilot states its number to a human as fact, so it uses
 * `availableQtySumSql` and nothing else.
 */
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
export class OpsCopilotTools {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly toolAccess: ToolAccessService,
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

  buildTools(ctx: OpsCopilotContext) {
    const { actor } = ctx;
    const { orgId, userId } = actor;

    return {
      getInventoryStock: tool({
        description:
          "Search for inventory products by name and show their current stock availability. Returns up to 5 matching products with on-hand, committed, and available quantities.",
        inputSchema: z.object({
          productQuery: z.string().min(1).max(120).describe("Partial product name to search for"),
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

          const scope = await this.warehouseScope.forUser(orgId, userId);

          const q = `%${productQuery.trim()}%`;
          // Soft-deleted products are withdrawn from the catalogue, and §3's rule
          // is that every read filters them: without this the assistant happily
          // quotes stock for a SKU the product screens no longer show.
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
                eq(invProducts.orgId, orgId),
                isNull(invProducts.deletedAt),
                ilike(invProducts.name, q),
              ),
            )
            .limit(STOCK_LOOKUP_CAPS.products);

          if (matched.length === 0) {
            return {
              results: [],
              message: `No products found matching "${productQuery}".`,
            };
          }

          // One read for every matched product's variants rather than one per
          // product: the lookup is bounded by the product cap either way, but a
          // query inside the map is the N+1 shape the growing-loop gate refuses.
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
                eq(invProductVariants.orgId, orgId),
                inArray(invProductVariants.productId, productIds),
                isNull(invProductVariants.deletedAt),
              ),
            )
            .orderBy(invProductVariants.productId, invProductVariants.id)
            .limit(STOCK_LOOKUP_CAPS.variantScan);

          const variantsByProduct = new Map<
            number,
            Array<{ id: number; name: string }>
          >();
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
            orgId,
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
