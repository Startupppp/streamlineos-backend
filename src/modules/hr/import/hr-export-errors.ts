import { ServiceUnavailableException } from "@nestjs/common";
import { isUndefinedTable } from "../../../common/db/postgres-error";

export function isMissingHrExportTable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (isUndefinedTable(error)) return true;
  if (
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("hr_export_jobs") &&
    error.message.includes("does not exist")
  ) {
    return true;
  }
  return "cause" in error && isMissingHrExportTable(error.cause);
}

export function hrExportUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: "HR_EXPORT_NOT_READY",
    message:
      "Employee exports are temporarily unavailable while secure export storage is being activated.",
  });
}
