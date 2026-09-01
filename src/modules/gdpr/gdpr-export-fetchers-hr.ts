import { and, asc, eq, gt, isNull } from "drizzle-orm";
import {
  assetReturns,
  documents,
  hrAttendanceRegularizations,
  hrDataRequests,
  hrEmployments,
  hrLegalHolds,
  hrPeople,
  hrReportingLines,
  onboardingDocuments,
  policyAcknowledgments,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { BATCH_SIZE } from "./gdpr-export-types";

export async function fetchEmployment(
  db: Db,
  orgId: string,
  subjectUserId: string,
  afterId: number | undefined,
) {
  const personRows = await db
    .select({ id: hrPeople.id })
    .from(hrPeople)
    .where(
      and(
        eq(hrPeople.userId, subjectUserId),
        eq(hrPeople.orgId, orgId),
        isNull(hrPeople.deletedAt),
      ),
    )
    .limit(1);
  if (!personRows.length) return [];
  const conditions = [
    eq(hrEmployments.orgId, orgId),
    isNull(hrEmployments.deletedAt),
  ];
  if (afterId !== undefined) conditions.push(gt(hrEmployments.id, afterId));
  return db
    .select({
      id: hrEmployments.id,
      lifecycleStatus: hrEmployments.lifecycleStatus,
      departmentId: hrEmployments.departmentId,
      designation: hrEmployments.designation,
      joiningDate: hrEmployments.joiningDate,
      lastWorkingDay: hrEmployments.lastWorkingDay,
    })
    .from(hrEmployments)
    .innerJoin(hrPeople, eq(hrEmployments.personId, hrPeople.id))
    .where(
      and(
        ...conditions,
        eq(hrPeople.userId, subjectUserId),
        eq(hrPeople.orgId, orgId),
      ),
    )
    .orderBy(asc(hrEmployments.id))
    .limit(BATCH_SIZE);
}

export async function fetchDataRequests(
  db: Db,
  orgId: string,
  subjectUserId: string,
  afterId: number | undefined,
) {
  const conditions = [
    eq(hrDataRequests.subjectUserId, subjectUserId),
    eq(hrDataRequests.orgId, orgId),
    isNull(hrDataRequests.deletedAt),
  ];
  if (afterId !== undefined) conditions.push(gt(hrDataRequests.id, afterId));
  return db
    .select({
      id: hrDataRequests.id,
      orgId: hrDataRequests.orgId,
      type: hrDataRequests.type,
      status: hrDataRequests.status,
      reason: hrDataRequests.reason,
      createdAt: hrDataRequests.createdAt,
    })
    .from(hrDataRequests)
    .where(and(...conditions))
    .orderBy(asc(hrDataRequests.id))
    .limit(BATCH_SIZE);
}

export async function fetchLegalHolds(
  db: Db,
  orgId: string,
  subjectUserId: string,
  afterId: number | undefined,
) {
  const conditions = [
    eq(hrLegalHolds.subjectUserId, subjectUserId),
    eq(hrLegalHolds.orgId, orgId),
    isNull(hrLegalHolds.deletedAt),
  ];
  if (afterId !== undefined) conditions.push(gt(hrLegalHolds.id, afterId));
  return db
    .select({
      id: hrLegalHolds.id,
      reason: hrLegalHolds.reason,
      status: hrLegalHolds.status,
      placedAt: hrLegalHolds.placedAt,
      releasedAt: hrLegalHolds.releasedAt,
    })
    .from(hrLegalHolds)
    .where(and(...conditions))
    .orderBy(asc(hrLegalHolds.id))
    .limit(BATCH_SIZE);
}

export async function fetchReportingLines(
  db: Db,
  orgId: string,
  subjectUserId: string,
  afterId: number | undefined,
) {
  const conditions = [
    eq(hrReportingLines.orgId, orgId),
    eq(hrPeople.userId, subjectUserId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(hrReportingLines.id, afterId));
  return db
    .select({
      id: hrReportingLines.id,
      orgId: hrReportingLines.orgId,
      employmentId: hrReportingLines.employmentId,
      managerEmploymentId: hrReportingLines.managerEmploymentId,
      lineType: hrReportingLines.lineType,
      effectiveFrom: hrReportingLines.effectiveFrom,
      effectiveTo: hrReportingLines.effectiveTo,
      createdAt: hrReportingLines.createdAt,
    })
    .from(hrReportingLines)
    .innerJoin(
      hrEmployments,
      eq(hrReportingLines.employmentId, hrEmployments.id),
    )
    .innerJoin(hrPeople, eq(hrEmployments.personId, hrPeople.id))
    .where(and(...conditions))
    .orderBy(asc(hrReportingLines.id))
    .limit(BATCH_SIZE);
}

export async function fetchAttendanceRegularizations(
  db: Db,
  orgId: string,
  subjectUserId: string,
  afterId: number | undefined,
) {
  const conditions = [
    eq(hrAttendanceRegularizations.orgId, orgId),
    eq(hrAttendanceRegularizations.userId, subjectUserId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(hrAttendanceRegularizations.id, afterId));
  return db
    .select({
      id: hrAttendanceRegularizations.id,
      orgId: hrAttendanceRegularizations.orgId,
      userId: hrAttendanceRegularizations.userId,
      attendanceDate: hrAttendanceRegularizations.attendanceDate,
      requestedCheckIn: hrAttendanceRegularizations.requestedCheckIn,
      requestedCheckOut: hrAttendanceRegularizations.requestedCheckOut,
      reason: hrAttendanceRegularizations.reason,
      status: hrAttendanceRegularizations.status,
      rejectionReason: hrAttendanceRegularizations.rejectionReason,
      attendanceId: hrAttendanceRegularizations.attendanceId,
      createdAt: hrAttendanceRegularizations.createdAt,
      updatedAt: hrAttendanceRegularizations.updatedAt,
    })
    .from(hrAttendanceRegularizations)
    .where(and(...conditions))
    .orderBy(asc(hrAttendanceRegularizations.id))
    .limit(BATCH_SIZE);
}

export async function fetchDocuments(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [eq(documents.orgId, orgId), eq(documents.userId, userId)];
  if (afterId !== undefined) conditions.push(gt(documents.id, afterId));
  return db
    .select({
      id: documents.id,
      name: documents.name,
      description: documents.description,
      type: documents.type,
      category: documents.category,
      fileName: documents.fileName,
      fileSize: documents.fileSize,
      mimeType: documents.mimeType,
      version: documents.version,
      parentDocumentId: documents.parentDocumentId,
      isPublic: documents.isPublic,
      isActive: documents.isActive,
      expiryDate: documents.expiryDate,
      tags: documents.tags,
      uploadedBy: documents.uploadedBy,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(and(...conditions))
    .orderBy(asc(documents.id))
    .limit(BATCH_SIZE);
}

export async function fetchPolicyAcknowledgments(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(policyAcknowledgments.orgId, orgId),
    eq(policyAcknowledgments.userId, userId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(policyAcknowledgments.id, afterId));
  return db
    .select({
      id: policyAcknowledgments.id,
      documentId: policyAcknowledgments.documentId,
      status: policyAcknowledgments.status,
      acknowledgedAt: policyAcknowledgments.acknowledgedAt,
      createdAt: policyAcknowledgments.createdAt,
    })
    .from(policyAcknowledgments)
    .where(and(...conditions))
    .orderBy(asc(policyAcknowledgments.id))
    .limit(BATCH_SIZE);
}

export async function fetchOnboardingDocuments(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(onboardingDocuments.orgId, orgId),
    eq(onboardingDocuments.userId, userId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(onboardingDocuments.id, afterId));
  return db
    .select({
      id: onboardingDocuments.id,
      documentTypeId: onboardingDocuments.documentTypeId,
      fileName: onboardingDocuments.fileName,
      fileSize: onboardingDocuments.fileSize,
      mimeType: onboardingDocuments.mimeType,
      version: onboardingDocuments.version,
      status: onboardingDocuments.status,
      reviewedAt: onboardingDocuments.reviewedAt,
      remarks: onboardingDocuments.remarks,
      createdAt: onboardingDocuments.createdAt,
      updatedAt: onboardingDocuments.updatedAt,
    })
    .from(onboardingDocuments)
    .where(and(...conditions))
    .orderBy(asc(onboardingDocuments.id))
    .limit(BATCH_SIZE);
}

export async function fetchAssetReturns(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(assetReturns.orgId, orgId),
    eq(assetReturns.userId, userId),
  ];
  if (afterId !== undefined) conditions.push(gt(assetReturns.id, afterId));
  return db
    .select({
      id: assetReturns.id,
      assetId: assetReturns.assetId,
      assetName: assetReturns.assetName,
      status: assetReturns.status,
      returnedAt: assetReturns.returnedAt,
      condition: assetReturns.condition,
      notes: assetReturns.notes,
      createdAt: assetReturns.createdAt,
    })
    .from(assetReturns)
    .where(and(...conditions))
    .orderBy(asc(assetReturns.id))
    .limit(BATCH_SIZE);
}
