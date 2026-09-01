import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrCases,
  hrCaseNotes,
  hrCaseDocuments,
} from "../../../db/schema/hr/cases";
import { organizationMembers } from "../../../db/schema";
import { decodeCursor, buildCursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { HrAuditService } from "../core/hr-audit.service";
import type {
  CreateCaseInput,
  AnonymousReportInput,
  UpdateCaseInput,
  ListCasesInput,
  CreateNoteInput,
  AddDocumentInput,
} from "./dto/hr-cases.schemas";

const CASE_SEARCH_CAP = 500;
const CASE_NUMBER_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generateCaseNumber(): string {
  const prefix = "CASE";
  const suffix = Array.from({ length: 6 }, () =>
    CASE_NUMBER_CHARS[Math.floor(Math.random() * CASE_NUMBER_CHARS.length)],
  ).join("");
  return `${prefix}-${suffix}`;
}

@Injectable()
export class HrCasesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  private async membershipForUser(orgId: string, userId: string): Promise<number> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
      ),
      columns: { id: true },
    });
    if (!member) throw new ForbiddenException("Organization membership required.");
    return member.id;
  }

  async list(
    orgId: string,
    userId: string,
    hasConfidential: boolean,
    input: ListCasesInput,
    membershipId?: number | null,
  ) {
    const { cursor, limit, status, category, severity, search, assignedTo } = input;
    const pos = decodeCursor(cursor);

    const conditions = [eq(hrCases.orgId, orgId), isNull(hrCases.deletedAt)];

    if (!hasConfidential) {
      if (membershipId == null) throw new ForbiddenException("Organization membership required.");
      const assigneeMatch = eq(hrCases.assignedToMembershipId, membershipId);
      const visibilityFilter = or(eq(hrCases.confidential, false), assigneeMatch);
      if (visibilityFilter) conditions.push(visibilityFilter);
    }

    if (status) conditions.push(eq(hrCases.status, status));
    if (category) conditions.push(eq(hrCases.category, category));
    if (severity) conditions.push(eq(hrCases.severity, severity));
    if (assignedTo) conditions.push(eq(hrCases.assignedTo, assignedTo));
    if (search) conditions.push(await this.caseSearchCondition(search));
    if (pos) conditions.push(keysetBeforeId(hrCases.createdAt, hrCases.id, pos));

    const rows = await this.db
      .select({
        id: hrCases.id,
        caseNumber: hrCases.caseNumber,
        category: hrCases.category,
        severity: hrCases.severity,
        status: hrCases.status,
        summary: hrCases.summary,
        anonymous: hrCases.anonymous,
        confidential: hrCases.confidential,
        assignedTo: hrCases.assignedTo,
        subjectEmployeeId: hrCases.subjectEmployeeId,
        createdAt: hrCases.createdAt,
        updatedAt: hrCases.updatedAt,
        resolvedAt: hrCases.resolvedAt,
      })
      .from(hrCases)
      .where(and(...conditions))
      .orderBy(desc(hrCases.createdAt), desc(hrCases.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  private async caseSearchCondition(search: string): Promise<SQL> {
    const fallback = or(
      ilike(hrCases.summary, `%${search}%`),
      ilike(hrCases.caseNumber, `%${search}%`),
    )!;
    const rows = await this.db.execute(
      sql`SELECT app.search_hr_case_ids(${search}, ${CASE_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length === 0) return sql`false`;
    if (rows.length > CASE_SEARCH_CAP) return fallback;
    const ids = rows.map((r) => Number(r["id"]));
    return inArray(hrCases.id, ids);
  }

  async getById(
    orgId: string,
    id: number,
    userId: string,
    hasConfidential: boolean,
    membershipId?: number | null,
  ) {
    const [row] = await this.db
      .select()
      .from(hrCases)
      .where(and(eq(hrCases.orgId, orgId), eq(hrCases.id, id), isNull(hrCases.deletedAt)))
      .limit(1);

    if (!row) throw new NotFoundException("Case not found");

    if (!hasConfidential && membershipId == null) {
      throw new ForbiddenException("Organization membership required.");
    }
    const isAssigned = membershipId != null && row.assignedToMembershipId === membershipId;
    if (row.confidential && !hasConfidential && !isAssigned) {
      throw new ForbiddenException("Access denied to confidential case");
    }

    return row;
  }

  async create(
    orgId: string,
    userId: string,
    input: CreateCaseInput,
    membershipId?: number | null,
    ipAddress?: string,
  ) {
    const caseNumber = generateCaseNumber();
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");
    const assignedToMembershipId = input.assignedTo
      ? await this.membershipForUser(orgId, input.assignedTo)
      : null;

    const [newCase] = await this.db
      .insert(hrCases)
      .values({
        orgId,
        caseNumber,
        category: input.category,
        subjectEmployeeId: input.subjectEmployeeId ?? null,
        reportedBy: userId,
        reportedByMembershipId: membershipId,
        anonymous: false,
        confidential: input.confidential ?? true,
        severity: input.severity,
        status: "open",
        summary: input.summary,
        details: input.details,
        assignedTo: input.assignedTo ?? null,
        assignedToMembershipId,
      })
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_case",
      entityId: String(newCase!.id),
      action: "case.created",
      after: { caseNumber, category: input.category, severity: input.severity },
      ipAddress,
    });

    return newCase!;
  }

  async createAnonymous(orgId: string, input: AnonymousReportInput) {
    const caseNumber = generateCaseNumber();

    const [newCase] = await this.db
      .insert(hrCases)
      .values({
        orgId,
        caseNumber,
        category: input.category,
        subjectEmployeeId: null,
        reportedBy: null,
        anonymous: true,
        confidential: true,
        severity: input.severity,
        status: "open",
        summary: input.summary,
        details: input.details,
        assignedTo: null,
      })
      .returning({ id: hrCases.id, caseNumber: hrCases.caseNumber });

    await this.audit.log({
      orgId,
      actorId: null,
      entityType: "hr_case",
      entityId: String(newCase!.id),
      action: "case.anonymous_report",
      after: { caseNumber, category: input.category },
    });

    return { caseNumber: newCase!.caseNumber };
  }

  async update(
    orgId: string,
    id: number,
    userId: string,
    hasConfidential: boolean,
    input: UpdateCaseInput,
    membershipId?: number | null,
    ipAddress?: string,
  ) {
    const existing = await this.getById(orgId, id, userId, hasConfidential, membershipId);
    const assignedToMembershipId = input.assignedTo === undefined
      ? undefined
      : input.assignedTo === null
        ? null
        : await this.membershipForUser(orgId, input.assignedTo);

    const resolvedAt =
      input.status === "resolved" && existing.status !== "resolved"
        ? new Date()
        : undefined;

    const [updated] = await this.db
      .update(hrCases)
      .set({
        ...(input.status !== undefined && { status: input.status }),
        ...(input.severity !== undefined && { severity: input.severity }),
        ...(input.assignedTo !== undefined && { assignedTo: input.assignedTo }),
        ...(assignedToMembershipId !== undefined && { assignedToMembershipId }),
        ...(input.outcome !== undefined && { outcome: input.outcome }),
        ...(input.summary !== undefined && { summary: input.summary }),
        ...(input.details !== undefined && { details: input.details }),
        ...(input.confidential !== undefined && { confidential: input.confidential }),
        ...(resolvedAt && { resolvedAt }),
        updatedAt: new Date(),
      })
      .where(and(eq(hrCases.orgId, orgId), eq(hrCases.id, id)))
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_case",
      entityId: String(id),
      action: "case.updated",
      before: { status: existing.status, severity: existing.severity },
      after: input,
      ipAddress,
    });

    return updated!;
  }

  async softDelete(orgId: string, id: number, userId: string, hasConfidential: boolean, membershipId?: number | null) {
    await this.getById(orgId, id, userId, hasConfidential, membershipId);

    await this.db
      .update(hrCases)
      .set({ deletedAt: new Date() })
      .where(and(eq(hrCases.orgId, orgId), eq(hrCases.id, id)));

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_case",
      entityId: String(id),
      action: "case.deleted",
    });
  }

  async listNotes(
    orgId: string,
    caseId: number,
    userId: string,
    hasConfidential: boolean,
    membershipId?: number | null,
  ) {
    await this.getById(orgId, caseId, userId, hasConfidential, membershipId);

    const conditions: SQL[] = [eq(hrCaseNotes.caseId, caseId), eq(hrCaseNotes.orgId, orgId)];

    if (!hasConfidential) {
      if (membershipId == null) throw new ForbiddenException("Organization membership required.");
      const visibilityFilter = or(eq(hrCaseNotes.isConfidential, false), eq(hrCaseNotes.authorMembershipId, membershipId));
      if (visibilityFilter) conditions.push(visibilityFilter);
    }

    return this.db
      .select()
      .from(hrCaseNotes)
      .where(and(...conditions))
      .orderBy(desc(hrCaseNotes.createdAt))
      .limit(100);
  }

  async addNote(
    orgId: string,
    caseId: number,
    userId: string,
    hasConfidential: boolean,
    input: CreateNoteInput,
    membershipId?: number | null,
    ipAddress?: string,
  ) {
    await this.getById(orgId, caseId, userId, hasConfidential, membershipId);
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");

    if (input.isConfidential && !hasConfidential) {
      throw new ForbiddenException("Cannot create confidential notes without hr:cases:confidential");
    }

    const [note] = await this.db
      .insert(hrCaseNotes)
      .values({
        caseId,
        orgId,
        authorId: userId,
        authorMembershipId: membershipId,
        note: input.note,
        isConfidential: input.isConfidential ?? false,
      })
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_case",
      entityId: String(caseId),
      action: "case.note_added",
      after: { isConfidential: input.isConfidential ?? false },
      ipAddress,
    });

    return note!;
  }

  async listDocuments(orgId: string, caseId: number, userId: string, hasConfidential: boolean, membershipId?: number | null) {
    await this.getById(orgId, caseId, userId, hasConfidential, membershipId);

    const conditions: SQL[] = [eq(hrCaseDocuments.caseId, caseId), eq(hrCaseDocuments.orgId, orgId)];

    if (!hasConfidential) {
      conditions.push(eq(hrCaseDocuments.restricted, false));
    }

    return this.db
      .select()
      .from(hrCaseDocuments)
      .where(and(...conditions))
      .orderBy(desc(hrCaseDocuments.createdAt))
      .limit(100);
  }

  async addDocument(
    orgId: string,
    caseId: number,
    userId: string,
    hasConfidential: boolean,
    input: AddDocumentInput,
    membershipId?: number | null,
    ipAddress?: string,
  ) {
    await this.getById(orgId, caseId, userId, hasConfidential, membershipId);

    const [doc] = await this.db
      .insert(hrCaseDocuments)
      .values({
        caseId,
        orgId,
        name: input.name,
        url: input.url,
        restricted: input.restricted ?? false,
        uploadedBy: userId,
      })
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_case",
      entityId: String(caseId),
      action: "case.document_added",
      after: { name: input.name },
      ipAddress,
    });

    return doc!;
  }

  async startInvestigation(
    orgId: string,
    caseId: number,
    userId: string,
    hasConfidential: boolean,
    membershipId?: number | null,
    ipAddress?: string,
  ) {
    const existing = await this.getById(orgId, caseId, userId, hasConfidential, membershipId);

    if (existing.status !== "open") {
      throw new ForbiddenException("Investigation can only be started on open cases");
    }

    const [updated] = await this.db
      .update(hrCases)
      .set({ status: "under_investigation", updatedAt: new Date() })
      .where(and(eq(hrCases.orgId, orgId), eq(hrCases.id, caseId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_case",
      entityId: String(caseId),
      action: "case.investigation_started",
      before: { status: existing.status },
      after: { status: "under_investigation" },
      ipAddress,
    });

    return updated!;
  }

  async countByStatus(orgId: string) {
    const rows = await this.db
      .select({ status: hrCases.status, total: sql<number>`cast(count(*) as int)` })
      .from(hrCases)
      .where(and(eq(hrCases.orgId, orgId), isNull(hrCases.deletedAt)))
      .groupBy(hrCases.status);

    return rows;
  }
}
