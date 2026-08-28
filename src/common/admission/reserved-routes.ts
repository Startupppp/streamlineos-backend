import type { WorkClass } from "./work-class";

export interface ReservedRoute {
  readonly prefix: string;
  readonly workClass: WorkClass;
}

export const RESERVED_ROUTES: readonly ReservedRoute[] = [
  { prefix: "auth", workClass: "authentication" },
  { prefix: "sessions", workClass: "authorization-revocation" },
  { prefix: "access", workClass: "authorization-revocation" },
  { prefix: "module-access", workClass: "authorization-revocation" },
  { prefix: "ownership", workClass: "ownership" },
  { prefix: "billing", workClass: "billing-ledger" },
  { prefix: "payments", workClass: "billing-ledger" },
  { prefix: "webhooks/razorpay", workClass: "billing-ledger" },
  { prefix: "webhooks/payments", workClass: "billing-ledger" },
  { prefix: "payroll/runs", workClass: "payroll-posting" },
  { prefix: "internal/audit", workClass: "audit" },
];

export function normalisePath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? "";
  return withoutQuery.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
}

export function reservedClassForPath(path: string): WorkClass | undefined {
  const normalised = normalisePath(path);

  for (const route of RESERVED_ROUTES)
    if (normalised === route.prefix || normalised.startsWith(`${route.prefix}/`))
      return route.workClass;

  return undefined;
}
