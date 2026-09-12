/**
 * What the chart-of-accounts service takes and returns. Split out of
 * `accounts.service.ts`, which re-exports all three.
 */
import type { GlAccountType, GlSystemTag } from "../../../../db/schema";

export interface CreateAccountInput {
  code: string;
  name: string;
  accountType: GlAccountType;
  parentAccountId?: string | null;
  isHeader?: boolean;
  isCash?: boolean;
  systemTag?: GlSystemTag | null;
  currencyRestriction?: string | null;
  description?: string | null;
}

export interface UpdateAccountInput {
  name?: string;
  parentAccountId?: string | null;
  isActive?: boolean;
  isCash?: boolean;
  currencyRestriction?: string | null;
  description?: string | null;
}

export interface AccountNode {
  id: string;
  code: string;
  name: string;
  accountType: GlAccountType;
  parentAccountId: string | null;
  isHeader: boolean;
  isActive: boolean;
  isCash: boolean;
  systemTag: GlSystemTag | null;
  currencyRestriction: string | null;
  description: string | null;
  children: AccountNode[];
}
