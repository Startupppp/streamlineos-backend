export function requirePayrollUserIds(ids: Array<string | null>): string[] {
  return ids.filter((id): id is string => id !== null);
}
