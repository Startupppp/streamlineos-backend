import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";

const REPORT_CATALOG = [
  {
    id: "overview",
    name: "Finance Overview",
    description: "High-level dashboard: cash, revenue, expenses, AR/AP, burn rate.",
    endpoint: "GET /accounting/overview",
    params: ["from?", "to?"],
    category: "Overview",
    exportable: false,
  },
  {
    id: "vendor-statement",
    name: "Vendor Statement",
    description: "Chronological AP activity for a vendor with running balance.",
    endpoint: "GET /accounting/reports/vendor-statement/:vendorId",
    params: ["from", "to"],
    category: "Payables",
    exportable: true,
  },
  {
    id: "customer-statement",
    name: "Customer Statement",
    description: "Chronological AR activity for a customer with running balance.",
    endpoint: "GET /accounting/reports/customer-statement/:clientId",
    params: ["from", "to"],
    category: "Receivables",
    exportable: true,
  },
  {
    id: "sales-by-customer",
    name: "Sales by Customer",
    description: "Invoice totals, payments, and outstanding amounts grouped by customer.",
    endpoint: "GET /accounting/reports/sales-by-customer",
    params: ["from", "to"],
    category: "Sales",
    exportable: true,
  },
  {
    id: "sales-by-item",
    name: "Sales by Item",
    description: "Revenue breakdown by line-item description.",
    endpoint: "GET /accounting/reports/sales-by-item",
    params: ["from", "to"],
    category: "Sales",
    exportable: true,
  },
  {
    id: "expense-by-category",
    name: "Expense by Category",
    description: "Approved and paid expenses grouped by expense category.",
    endpoint: "GET /accounting/reports/expense-by-category",
    params: ["from", "to"],
    category: "Expenses",
    exportable: true,
  },
  {
    id: "tax-summary",
    name: "GST Tax Summary",
    description: "Monthly CGST/SGST/IGST output vs input tax summary and net payable.",
    endpoint: "GET /accounting/reports/tax-summary",
    params: ["from", "to"],
    category: "Tax",
    exportable: true,
  },
  {
    id: "project-profitability",
    name: "Project Profitability",
    description: "Revenue, cost, and margin per project from journal and expense data.",
    endpoint: "GET /accounting/reports/project-profitability",
    params: ["from", "to"],
    category: "Analytics",
    exportable: true,
  },
  {
    id: "department-profitability",
    name: "Department Profitability",
    description: "Revenue, cost, and margin per department from journal data.",
    endpoint: "GET /accounting/reports/department-profitability",
    params: ["from", "to"],
    category: "Analytics",
    exportable: true,
  },
  {
    id: "budget-vs-actual",
    name: "Budget vs Actual",
    description: "Line-by-line variance between approved budget and actual journal activity.",
    endpoint: "GET /accounting/reports/budget-vs-actual",
    params: ["budgetId", "from", "to"],
    category: "Budgeting",
    exportable: true,
  },
  {
    id: "working-capital",
    name: "Working Capital",
    description: "Current assets vs current liabilities and working capital ratio as of a date.",
    endpoint: "GET /accounting/reports/working-capital",
    params: ["asOf?"],
    category: "Analytics",
    exportable: false,
  },
  {
    id: "burn-rate",
    name: "Burn Rate",
    description: "Average monthly cash outflow over the last 3 full calendar months.",
    endpoint: "GET /accounting/reports/burn-rate",
    params: [],
    category: "Analytics",
    exportable: false,
  },
  {
    id: "cash-runway",
    name: "Cash Runway",
    description: "Projected months of runway given current cash and average burn rate.",
    endpoint: "GET /accounting/reports/cash-runway",
    params: ["months?"],
    category: "Analytics",
    exportable: false,
  },
] as const;

@RequireModule("accounting")
@Controller("accounting/reports")
@UseGuards(JwtAuthGuard)
export class CatalogController {
  @Get("catalog")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getCatalog() {
    return REPORT_CATALOG;
  }
}
