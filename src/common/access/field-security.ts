import type { CurrentUserContext } from "../auth/backend-claims";

const FIELD_PERMISSION_MAP: Record<string, string[]> = {
  "hr:employee.salary:view": ["salary", "ctc", "grossSalary", "netSalary", "salaryBreakdown"],
  "hr:employee.bank:view": ["bankAccount", "ifscCode", "bankName", "accountNumber"],
  "hr:employee.personal:view": ["dateOfBirth", "gender", "homeAddress", "emergencyContact"],
  "hr:employee.documents:view": ["documents", "governmentId", "passport"],
};

export function maskSensitiveFields<T extends Record<string, unknown>>(
  obj: T,
  ctx: CurrentUserContext,
): Partial<T> {
  if (ctx.isPlatformAdmin || ctx.isOrgOwner) return obj;

  const result = { ...obj };
  for (const [permKey, fields] of Object.entries(FIELD_PERMISSION_MAP)) {
    const hasPerm = (ctx.permissions ?? []).includes(permKey);
    if (!hasPerm) {
      for (const field of fields) {
        if (field in result) {
          (result as Record<string, unknown>)[field] = undefined;
        }
      }
    }
  }
  return result;
}

export function hasFieldPermission(ctx: CurrentUserContext, permKey: string): boolean {
  if (ctx.isPlatformAdmin || ctx.isOrgOwner) return true;
  return (ctx.permissions ?? []).includes(permKey);
}
