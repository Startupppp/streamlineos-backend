import { assertNever } from "../auth/principal";

export type SheddableClass =
  | "prefetch"
  | "analytics-refresh"
  | "ai-enrichment"
  | "search-freshness"
  | "non-mandatory-notification"
  | "ordinary-write";

export type ReservedClass =
  | "authentication"
  | "authorization-revocation"
  | "ownership"
  | "billing-ledger"
  | "payroll-posting"
  | "audit"
  | "mandatory-security-delivery";

export type WorkClass = SheddableClass | ReservedClass;

export const NUM_SHEDDABLE_RANKS = 6;

export function isReserved(wc: WorkClass): wc is ReservedClass {
  switch (wc) {
    case "prefetch":
    case "analytics-refresh":
    case "ai-enrichment":
    case "search-freshness":
    case "non-mandatory-notification":
    case "ordinary-write":
      return false;
    case "authentication":
    case "authorization-revocation":
    case "ownership":
    case "billing-ledger":
    case "payroll-posting":
    case "audit":
    case "mandatory-security-delivery":
      return true;
    default:
      return assertNever(wc);
  }
}

export function shedRank(wc: SheddableClass): number {
  switch (wc) {
    case "prefetch":
      return 0;
    case "analytics-refresh":
      return 1;
    case "ai-enrichment":
      return 2;
    case "search-freshness":
      return 3;
    case "non-mandatory-notification":
      return 4;
    case "ordinary-write":
      return 5;
    default:
      return assertNever(wc);
  }
}
