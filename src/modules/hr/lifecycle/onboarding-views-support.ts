import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import { SQL, aliasedTable, ilike, inArray, or, sql } from "drizzle-orm";
import { decodeCursor } from "../../../common/pagination/cursor";
import { AutomationService } from "../../automation/automation.service";
import type { Db } from "../../../db/drizzle.module";
import { hrEmployments, hrPeople, users } from "../../../db/schema";

export const reviewerUsers = aliasedTable(users, "reviewer");

export type OnboardingDocumentListRow = {
  id: number;
  orgId: string;
  userId: string;
  employeeName: string | null;
  documentTypeId: number;
  documentTypeName: string;
  isMandatory: boolean;
  hasFile: boolean;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  version: number;
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  remarks: string | null;
  createdAt: Date;
  updatedAt: Date;
  reviewerName: string | null;
};

const ONBOARDING_SEARCH_CAP = 500;

export async function onboardingSearchCondition(db: Db, search: string): Promise<SQL> {
  const designationIlike = ilike(hrEmployments.designation, `%${search}%`);
  const rows = await db.execute(
    sql`SELECT app.search_hr_person_ids(${search}, ${ONBOARDING_SEARCH_CAP + 1}) AS id`,
  );
  if (rows.length === 0) return designationIlike;
  if (rows.length > ONBOARDING_SEARCH_CAP) {
    const fallback = or(ilike(users.name, `%${search}%`), designationIlike);
    if (!fallback) throw new InternalServerErrorException("Failed to build onboarding search fallback");
    return fallback;
  }
  const ids = rows.map((r) => Number(r["id"]));
  const condition = or(inArray(hrPeople.id, ids), designationIlike);
  if (!condition) throw new InternalServerErrorException("Failed to build onboarding search condition");
  return condition;
}

export function decodeOnboardingSummaryCursor(value: string | undefined) {
  if (value === undefined) return null;
  const position = decodeCursor(value);
  if (!position) throw new BadRequestException("Invalid pagination cursor");
  try {
    const name: unknown = JSON.parse(position.sortValue);
    if (name !== null && typeof name !== "string") throw new Error();
    return { name: name as string | null, userId: position.id };
  } catch {
    throw new BadRequestException("Invalid pagination cursor");
  }
}

export function dispatchOnboardingDocumentSubmittedEvent(
  automation: AutomationService,
  orgId: string,
  documentId: number,
  targetUserId: string,
  documentTypeName: string,
): Promise<void> {
  return automation
    .runAutomationsForEvent(orgId, "onboarding.document_submitted", {
      documentId,
      userId: targetUserId,
      documentTypeName,
      status: "SUBMITTED",
      submittedAt: new Date().toISOString(),
    })
    .catch(() => undefined);
}
