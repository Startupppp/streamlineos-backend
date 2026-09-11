import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, ilike, isNull, or, type SQL, type SQLWrapper } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../../common/audit/audit.service";
import { OrgHierarchyCacheService } from "../../../common/cache/org-hierarchy-cache.service";
import { organizationMembers, orgUnits } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { ListQueryInput } from "./dto/org-hierarchy.schemas";
import type { OrgUnitKind } from "./org-hierarchy-dependencies.service";
import {
  getOrgUnitCursorFilter,
  getOrgUnitStatusFilter,
  orgUnitNormalizedName,
  toOrgUnitCursorPage,
} from "./org-hierarchy-list-filters";

type OrgUnitStatus = typeof orgUnits.$inferSelect.status;
type OrgUnitInsert = typeof orgUnits.$inferInsert;

export type OrgUnitCreateValues = Pick<OrgUnitInsert, "name"> &
  Partial<Pick<OrgUnitInsert, "description" | "metadata" | "status">>;

export type OrgUnitUpdateValues = Partial<
  Pick<OrgUnitInsert, "name" | "description" | "metadata" | "status">
>;

const ORG_UNIT_WRITE_COLUMNS = {
  id: orgUnits.id,
  orgId: orgUnits.orgId,
  name: orgUnits.name,
  code: orgUnits.code,
  description: orgUnits.description,
  status: orgUnits.status,
  parentId: orgUnits.parentId,
  metadata: orgUnits.metadata,
  createdAt: orgUnits.createdAt,
  updatedAt: orgUnits.updatedAt,
  deletedAt: orgUnits.deletedAt,
};

export type OrgUnitWriteRow = Pick<
  typeof orgUnits.$inferSelect,
  | "id"
  | "orgId"
  | "name"
  | "code"
  | "description"
  | "status"
  | "parentId"
  | "metadata"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
> & { headUserId: string | null };

export interface OrgUnitListPlan {
  where: SQL | undefined;
  orderBy: readonly [SQL, SQL];
  limit: number;
}

export interface OrgUnitCodeStrategy<TCreate, TUpdate, TRead> {
  create(input: TCreate): string;
  update?: (input: TUpdate) => string | undefined;
  current?: (row: TRead) => string;
  unique?: boolean;
  includeDeleted?: boolean;
}

export interface OrgUnitParentStrategy<TCreate, TUpdate, TRead> {
  rule: "absent" | "optional" | "required";
  kind: "BUSINESS_UNIT" | "BRANCH" | "DEPARTMENT";
  label: string;
  create?: (input: TCreate) => string | null | undefined;
  update?: (input: TUpdate) => string | null | undefined;
  current: (row: TRead) => string | null;
  validate?: (db: Db, orgId: string, parentId: string) => Promise<void>;
}

export interface OrgUnitHeadStrategy<TCreate, TUpdate, TRead> {
  create: (input: TCreate) => string | null | undefined;
  update: (input: TUpdate) => string | null | undefined;
  current: (row: TRead) => string | null;
}

export interface OrgUnitCrudAdapter<
  TCreate,
  TUpdate extends { status?: OrgUnitStatus },
  TRead extends { id: string; name: string },
  TList extends { id: string; name: string },
  TOutput,
  TListOutput = TOutput,
> {
  kind: OrgUnitKind;
  label: string;
  auditName: string;
  searchExtension?: (pattern: string) => SQLWrapper;
  code: OrgUnitCodeStrategy<TCreate, TUpdate, TRead>;
  parent?: OrgUnitParentStrategy<TCreate, TUpdate, TRead>;
  head?: OrgUnitHeadStrategy<TCreate, TUpdate, TRead>;
  listRows: (db: Db, plan: OrgUnitListPlan) => Promise<TList[]>;
  readRow: (db: Db, where: SQL | undefined) => Promise<TRead | null>;
  createValues: (
    input: TCreate,
  ) => OrgUnitCreateValues | Promise<OrgUnitCreateValues>;
  updateValues: (
    input: TUpdate,
    existing: TRead,
  ) => OrgUnitUpdateValues | Promise<OrgUnitUpdateValues>;
  validateCreate?: (db: Db, orgId: string, input: TCreate) => Promise<void>;
  validateUpdate?: (
    db: Db,
    orgId: string,
    input: TUpdate,
    existing: TRead,
  ) => Promise<void>;
  toOutput: (row: TRead) => TOutput;
  toListOutput: (row: TList) => TListOutput;
  toWriteOutput: (row: OrgUnitWriteRow) => TOutput;
}

function getOrgUnitListFilter(
  orgId: string,
  kind: OrgUnitKind,
  query: ListQueryInput,
  searchExtension?: (pattern: string) => SQLWrapper,
) {
  const status = getOrgUnitStatusFilter(query.status);
  const cursor = getOrgUnitCursorFilter(query.cursor);
  const pattern = query.search ? `%${query.search}%` : undefined;
  const search = pattern
    ? or(
        ilike(orgUnits.name, pattern),
        ilike(orgUnits.code, pattern),
        ...(searchExtension ? [searchExtension(pattern)] : []),
      )
    : undefined;
  return and(
    eq(orgUnits.orgId, orgId),
    eq(orgUnits.kind, kind),
    isNull(orgUnits.deletedAt),
    ...(search ? [search] : []),
    ...(status ? [status] : []),
    ...(cursor ? [cursor] : []),
  );
}

function getOrgUnitRowFilter(orgId: string, kind: OrgUnitKind, id: string) {
  return and(
    eq(orgUnits.id, id),
    eq(orgUnits.orgId, orgId),
    eq(orgUnits.kind, kind),
    isNull(orgUnits.deletedAt),
  );
}

function getOrgUnitWriteFilter(orgId: string, kind: OrgUnitKind, id: string) {
  return and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, kind));
}

@Injectable()
export class OrgUnitCrudService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(AuditService)
    private readonly audit: Pick<AuditService, "logCritical">,
    @Inject(OrgHierarchyCacheService)
    private readonly cache: Pick<OrgHierarchyCacheService, "invalidateAfterMutation">,
  ) {}

  async list<TCreate, TUpdate extends { status?: OrgUnitStatus }, TRead extends { id: string; name: string }, TList extends { id: string; name: string }, TOutput, TListOutput>(
    adapter: OrgUnitCrudAdapter<TCreate, TUpdate, TRead, TList, TOutput, TListOutput>,
    orgId: string,
    query: ListQueryInput,
  ) {
    const rows = await adapter.listRows(this.db, {
      where: getOrgUnitListFilter(
        orgId,
        adapter.kind,
        query,
        adapter.searchExtension,
      ),
      orderBy: [asc(orgUnitNormalizedName), asc(orgUnits.id)],
      limit: query.limit + 1,
    });
    return toOrgUnitCursorPage(rows, query.limit, adapter.toListOutput);
  }

  async get<TCreate, TUpdate extends { status?: OrgUnitStatus }, TRead extends { id: string; name: string }, TList extends { id: string; name: string }, TOutput, TListOutput>(
    adapter: OrgUnitCrudAdapter<TCreate, TUpdate, TRead, TList, TOutput, TListOutput>,
    orgId: string,
    id: string,
  ): Promise<TOutput | null> {
    const row = await adapter.readRow(
      this.db,
      getOrgUnitRowFilter(orgId, adapter.kind, id),
    );
    return row ? adapter.toOutput(row) : null;
  }

  async create<TCreate, TUpdate extends { status?: OrgUnitStatus }, TRead extends { id: string; name: string }, TList extends { id: string; name: string }, TOutput, TListOutput>(
    adapter: OrgUnitCrudAdapter<TCreate, TUpdate, TRead, TList, TOutput, TListOutput>,
    orgId: string,
    userId: string,
    input: TCreate,
  ): Promise<TOutput> {
    await Promise.all([
      this.validateCreateParent(adapter, orgId, input),
      adapter.validateCreate?.(this.db, orgId, input),
    ]);
    const code = adapter.code.create(input).toUpperCase();
    if (adapter.code.unique !== false)
      await this.assertCodeAvailable(orgId, adapter, code);
    const headUserId = adapter.head?.create(input) ?? null;
    const headMembershipId = await this.resolveHeadMembershipId(orgId, headUserId);
    const values = await adapter.createValues(input);
    const parentId = adapter.parent?.create?.(input);
    const [row] = await this.db
      .insert(orgUnits)
      .values({
        ...values,
        id: randomUUID(),
        orgId,
        kind: adapter.kind,
        code,
        ...(adapter.parent?.rule !== "absent" && parentId !== undefined
          ? { parentId }
          : {}),
        ...(adapter.head ? { headMembershipId } : {}),
      })
      .returning(ORG_UNIT_WRITE_COLUMNS);
    if (!row) throw new Error(`Failed to create ${adapter.label.toLowerCase()}`);
    await this.auditMutation(adapter, "created", orgId, userId, row.id);
    return adapter.toWriteOutput({ ...row, headUserId });
  }

  async update<TCreate, TUpdate extends { status?: OrgUnitStatus }, TRead extends { id: string; name: string }, TList extends { id: string; name: string }, TOutput, TListOutput>(
    adapter: OrgUnitCrudAdapter<TCreate, TUpdate, TRead, TList, TOutput, TListOutput>,
    orgId: string,
    userId: string,
    id: string,
    input: TUpdate,
  ): Promise<TOutput> {
    const existing = await adapter.readRow(
      this.db,
      getOrgUnitRowFilter(orgId, adapter.kind, id),
    );
    if (!existing) throw new NotFoundException(`${adapter.label} not found`);
    await Promise.all([
      this.validateUpdateParent(adapter, orgId, input, existing),
      adapter.validateUpdate?.(this.db, orgId, input, existing),
    ]);
    const code = adapter.code.update?.(input)?.toUpperCase();
    if (
      adapter.code.unique !== false &&
      code !== undefined &&
      code !== adapter.code.current?.(existing)
    )
      await this.assertCodeAvailable(orgId, adapter, code);
    const requestedHead = adapter.head?.update(input);
    const headMembershipId = await this.resolveHeadMembershipId(
      orgId,
      requestedHead,
    );
    const headUserId =
      requestedHead !== undefined
        ? (requestedHead ?? null)
        : (adapter.head?.current(existing) ?? null);
    const values = await adapter.updateValues(input, existing);
    const parentId = adapter.parent?.update?.(input);
    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...values,
        ...(code !== undefined ? { code } : {}),
        ...(adapter.parent?.rule !== "absent" && parentId !== undefined
          ? { parentId }
          : {}),
        ...(adapter.head && requestedHead !== undefined
          ? { headMembershipId }
          : {}),
      })
      .where(getOrgUnitWriteFilter(orgId, adapter.kind, id))
      .returning(ORG_UNIT_WRITE_COLUMNS);
    if (!row) throw new NotFoundException(`${adapter.label} not found`);
    await this.auditMutation(adapter, "updated", orgId, userId, id);
    return adapter.toWriteOutput({ ...row, headUserId });
  }

  private async assertCodeAvailable(
    orgId: string,
    adapter: {
      kind: OrgUnitKind;
      label: string;
      code: { includeDeleted?: boolean };
    },
    code: string,
  ): Promise<void> {
    const conflict = await this.db.query.orgUnits.findFirst({
      columns: { id: true },
      where: and(
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, adapter.kind),
        eq(orgUnits.code, code),
        ...(adapter.code.includeDeleted ? [] : [isNull(orgUnits.deletedAt)]),
      ),
    });
    if (conflict) throw new ConflictException(`${adapter.label} code already exists`);
  }

  private async resolveHeadMembershipId(
    orgId: string,
    userId: string | null | undefined,
  ): Promise<number | null | undefined> {
    if (userId === undefined) return undefined;
    if (!userId) return null;
    const [member] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    return member?.id ?? null;
  }

  private async validateCreateParent<TCreate, TUpdate extends { status?: OrgUnitStatus }, TRead extends { id: string; name: string }, TList extends { id: string; name: string }, TOutput, TListOutput>(
    adapter: OrgUnitCrudAdapter<TCreate, TUpdate, TRead, TList, TOutput, TListOutput>,
    orgId: string,
    input: TCreate,
  ): Promise<void> {
    if (!adapter.parent || adapter.parent.rule === "absent") return;
    await this.assertParent(adapter.parent, orgId, adapter.parent.create?.(input));
  }

  private async validateUpdateParent<TCreate, TUpdate extends { status?: OrgUnitStatus }, TRead extends { id: string; name: string }, TList extends { id: string; name: string }, TOutput, TListOutput>(
    adapter: OrgUnitCrudAdapter<TCreate, TUpdate, TRead, TList, TOutput, TListOutput>,
    orgId: string,
    input: TUpdate,
    existing: TRead,
  ): Promise<void> {
    if (!adapter.parent) return;
    const requested = adapter.parent.update?.(input);
    if (adapter.parent.rule !== "absent" && requested !== undefined) {
      await this.assertParent(adapter.parent, orgId, requested);
      return;
    }
    if (input.status === "ACTIVE")
      await this.assertParent(adapter.parent, orgId, adapter.parent.current(existing));
  }

  private async assertParent(
    strategy: {
      rule: "absent" | "optional" | "required";
      kind: "BUSINESS_UNIT" | "BRANCH" | "DEPARTMENT";
      label: string;
      validate?: (db: Db, orgId: string, parentId: string) => Promise<void>;
    },
    orgId: string,
    parentId: string | null | undefined,
  ): Promise<void> {
    if (!parentId) {
      if (strategy.rule === "required")
        throw new BadRequestException(`Select an active ${strategy.label}.`);
      return;
    }
    if (strategy.validate) {
      await strategy.validate(this.db, orgId, parentId);
      return;
    }
    const [parent] = await this.db
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.id, parentId),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, strategy.kind),
          eq(orgUnits.status, "ACTIVE"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .limit(1);
    if (!parent)
      throw new BadRequestException({
        code: "ORG_UNIT_PARENT_UNAVAILABLE",
        message: `Select an active ${strategy.label}. Archived, disabled, or removed units cannot receive new assignments.`,
      });
  }

  private async auditMutation(
    adapter: { auditName: string },
    event: "created" | "updated",
    orgId: string,
    userId: string,
    targetId: string,
  ): Promise<void> {
    await this.audit.logCritical({
      action: `${adapter.auditName}.${event}`,
      userId,
      orgId,
      targetId,
      targetType: "org_unit",
    });
    await this.cache.invalidateAfterMutation(orgId);
  }
}
