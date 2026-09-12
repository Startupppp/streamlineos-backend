import { BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { organizations } from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";

export const UNSUPPORTED_SALARY_CURRENCY_MESSAGE =
  "This organization has no usable currency configured, so a salary cannot be recorded. Set the organization currency in Settings and try again.";

export function assertSalaryCurrency(raw: string | null | undefined): string {
  const code = (raw ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new BadRequestException(UNSUPPORTED_SALARY_CURRENCY_MESSAGE);
  return code;
}

export async function resolveOrgSalaryCurrency(
  executor: DbOrTx,
  orgId: string,
): Promise<string> {
  const [row] = await executor
    .select({ currency: organizations.currency })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row) throw new BadRequestException(UNSUPPORTED_SALARY_CURRENCY_MESSAGE);
  return assertSalaryCurrency(row.currency);
}
