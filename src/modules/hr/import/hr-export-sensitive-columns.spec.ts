/**
 * V-005. The HR export is safe only BY OMISSION.
 *
 * `GET /hr/export/:entity` takes its header from `exportColumnsOf(entity)`,
 * which is `Object.keys(getTableColumns(table))` — EVERY column of the table —
 * behind the single permission `hr:export:manage`. The employee export happens
 * to carry nothing sensitive today, but nothing in the code says so: the moment
 * somebody adds `bank_account_number` to `assets`, `geo_coordinates` to
 * `attendance`, or another classified column to `documents`, it ships to CSV the
 * same day, for every holder of one coarse permission, with no review.
 *
 * This suite is that review. The lists below are a FROZEN allowlist, not a
 * description of the table — adding a column to one of these four tables fails
 * this suite until someone has classified it and, if it is export-safe, listed
 * it here in the same change. Removing a column fails too, which is what keeps
 * the list from silently rotting.
 *
 * `document_metadata` is the one to look hardest at: it already carries
 * `classification`, `metadata` and `tags`, which are free-form.
 */
import { exportColumnsOf } from "./hr-export-columns";
import type { HrImportEntity } from "./dto/import-job.dto";

const ALLOWED: Record<string, string[]> = {
  attendance: [
    "id",
    "orgId",
    "userId",
    "userMembershipId",
    "workerId",
    "workerEngagementId",
    "date",
    "checkIn",
    "checkOut",
    "status",
    "workHours",
    "breakHours",
    "breaks",
    // Reviewed: coarse punch location. Not a live track — it is the same value
    // the attendance detail screen already shows the same permission holder.
    "locationData",
    "isOvertime",
    "autoCheckedOut",
    "locationVerified",
    "createdAt",
  ],
  assets: [
    "id",
    "orgId",
    "name",
    "type",
    "brand",
    "model",
    "serialNumber",
    "assignedTo",
    "assignedToMembershipId",
    "status",
    "purchaseDate",
    "purchaseCost",
    "location",
    "notes",
    "expectedReturnDate",
    "createdAt",
    "updatedAt",
  ],
  leave_balances: ["id", "orgId", "userId", "userMembershipId", "leaveTypeId", "balance", "year"],
  document_metadata: [
    "id",
    "orgId",
    "userId",
    "departmentId",
    "name",
    "description",
    "type",
    "classification",
    "effectiveDate",
    "category",
    "fileUrl",
    "fileName",
    "fileSize",
    "mimeType",
    "version",
    "parentDocumentId",
    "isPublic",
    "isActive",
    "expiryDate",
    "expiryReminderSent",
    "tags",
    "metadata",
    "uploadedBy",
    "userMembershipId",
    "createdAt",
    "updatedAt",
  ],
};

describe("HR export column sensitivity", () => {
  it.each(Object.keys(ALLOWED))(
    "%s exports only columns that have been classified",
    (entity) => {
      const columns = exportColumnsOf(entity as HrImportEntity);
      const unclassified = columns.filter((column) => !ALLOWED[entity]?.includes(column));
      expect(unclassified).toEqual([]);
    },
  );

  it.each(Object.keys(ALLOWED))(
    "%s's allowlist still describes the real table",
    (entity) => {
      const columns = exportColumnsOf(entity as HrImportEntity);
      // A stale entry means somebody dropped or renamed a column and the
      // allowlist no longer says anything about what actually ships.
      expect(ALLOWED[entity]?.filter((column) => !columns.includes(column))).toEqual([]);
    },
  );

  it("exports nothing for employees, which goes through its own curated job route", () => {
    expect(exportColumnsOf("employees")).toEqual([]);
  });
});
