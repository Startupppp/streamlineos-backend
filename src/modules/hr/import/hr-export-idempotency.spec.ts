import { createHash } from "node:crypto";
import { UnprocessableEntityException } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { DataScope } from "../../access/access.types";
import type { CreateEmployeeExportJobInput } from "./dto/export-job.dto";
import { HrExportJobsService } from "./hr-export-jobs.service";
import type { HrExportJobRow } from "./hr-export-jobs.types";

/**
 * `HrExportJobsService.create` fences on `(org_id, idempotency_key)` and then
 * re-checks that the stored job was requested by the same person with the same
 * filters. That second check had no test, and it is **not** redundant with
 * `@Idempotent`.
 *
 * `IdempotencyInterceptor` keys its `command_fences` row on
 * `(organizationId, audience, idempotencyKey)` — the *organization*, not the
 * user. Two members of one organization sending the same key therefore reach
 * the same fence, and the interceptor cannot tell them apart. Only this service
 * check can. Deleting it as a "duplicate fence" would remove real protection
 * rather than duplication, which is why these cases exist.
 */

const ORG = "org_1";
const REQUESTER = "user_requester";
const OTHER_MEMBER = "user_other";
const KEY = "8f1c0e2a-3b4d-4c5e-9f60-7a8b9c0d1e2f";
const FILTERS: CreateEmployeeExportJobInput = { filters: { search: "Ada", isActive: "all" } };
const SCOPE: DataScope = "all";

/** Mirrors the service: sha256 over the filters alone, not the whole body. */
function hashOf(input: CreateEmployeeExportJobInput): string {
  return createHash("sha256").update(JSON.stringify(input.filters)).digest("hex");
}

function actor(userId: string): CurrentUserContext {
  return {
    userId,
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session_1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function storedJob(overrides: Partial<HrExportJobRow>): HrExportJobRow {
  return {
    id: "job_1",
    orgId: ORG,
    entity: "employees",
    status: "pending",
    requestedBy: REQUESTER,
    idempotencyKey: KEY,
    filters: FILTERS.filters,
    processedRows: 0,
    rowCount: null,
    createdAt: new Date(0),
    ...overrides,
  } as HrExportJobRow;
}

/**
 * The drizzle surface `create` actually touches: an insert chain whose
 * `returning()` resolves empty — the `ON CONFLICT DO NOTHING` case — and a
 * select chain yielding the already-stored job that `findByIdempotency` loads.
 */
function serviceWith(existing: HrExportJobRow) {
  const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
  const db = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: async () => [] }),
      }),
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [existing] }) }),
    }),
  };
  const service = new HrExportJobsService(
    db as never,
    { isConfigured: () => true } as never,
    audit as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, audit };
}

describe("HR employee export — idempotency key ownership", () => {
  const previous = process.env.HR_EXPORT_WORKER_ENABLED;

  beforeAll(() => {
    process.env.HR_EXPORT_WORKER_ENABLED = "true";
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.HR_EXPORT_WORKER_ENABLED;
    else process.env.HR_EXPORT_WORKER_ENABLED = previous;
  });

  it("refuses a key already used by a different member of the same organization", async () => {
    const { service, audit } = serviceWith(
      storedJob({ requestedBy: REQUESTER, requestHash: hashOf(FILTERS) }),
    );

    await expect(
      service.create(actor(OTHER_MEMBER), FILTERS, SCOPE, KEY),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(audit.logCritical).not.toHaveBeenCalled();
  });

  it("refuses the original requester reusing the key with different filters", async () => {
    const { service, audit } = serviceWith(
      storedJob({ requestedBy: REQUESTER, requestHash: "a-hash-from-different-filters" }),
    );

    await expect(
      service.create(actor(REQUESTER), FILTERS, SCOPE, KEY),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(audit.logCritical).not.toHaveBeenCalled();
  });

  it("lets the original requester replay the identical request", async () => {
    const { service, audit } = serviceWith(
      storedJob({ requestedBy: REQUESTER, requestHash: hashOf(FILTERS) }),
    );

    await service.create(actor(REQUESTER), FILTERS, SCOPE, KEY);

    // Reaching the audit write is the proof the guard passed. Without this the
    // two cases above would still pass against a guard that refused everything.
    expect(audit.logCritical).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.employee_export.requested", resourceId: "job_1" }),
    );
  });
});
