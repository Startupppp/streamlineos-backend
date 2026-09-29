import { ConflictException, NotFoundException } from "@nestjs/common";
import { isUniqueViolation } from "../../../common/db/postgres-error";

export function assertRestorable(
  row: { deletedAt: Date | null } | undefined,
  label: string,
): void {
  if (!row) throw new NotFoundException(`${label} not found`);
  if (row.deletedAt === null)
    throw new ConflictException(`${label} is not deleted`);
}

export async function clearingLifecycle<T>(
  label: string,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictException(
        `${label} cannot be restored: a live row already holds one of its unique keys. Remove or rename that row first.`,
      );
    throw error;
  }
}
