/**
 * HR Cases actor-contraction spec.
 *
 * Asserts that the dual-read predicates in list() and getById() honour the
 * new assignedToMembershipId column, and that a revoked member (membershipId
 * set to a value that no longer matches a live row) cannot satisfy the
 * predicate when the DB row already carries the new column value.
 *
 * Pattern: supply membershipId = 99 (simulated live member) vs membershipId = 77
 * (simulated revoked — the DB row has assignedToMembershipId = 99).
 */

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { HrCasesService } from "./hr-cases.service";
import type { ListCasesInput } from "./dto/hr-cases.schemas";
import { hrCases } from "../../../db/schema/hr/cases";

const ORG_ID = "org-test";
const MEMBER_USER_ID = "user-abc";
const ACTIVE_MEMBERSHIP_ID = 99;
const REVOKED_MEMBERSHIP_ID = 77;

function makeCase(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: ORG_ID,
    caseNumber: "CASE-001",
    category: "grievance" as const,
    subjectEmployeeId: null,
    reportedBy: null,
    anonymous: false,
    confidential: true,
    severity: "low" as const,
    status: "open" as const,
    summary: "Test case",
    details: "Details",
    outcome: null,
    resolvedAt: null,
    assignedTo: MEMBER_USER_ID,
    assignedToMembershipId: ACTIVE_MEMBERSHIP_ID,
    reportedByMembershipId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function buildMockDb(selectRows: unknown[]) {
  const where = jest.fn().mockReturnThis();
  const orderBy = jest.fn().mockReturnThis();
  const limitFn = jest.fn().mockResolvedValue(selectRows);

  const selectFn = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({
          limit: limitFn,
        }),
      }),
    }),
  });

  return {
    select: jest.fn().mockReturnValue(selectFn()),
    execute: jest.fn().mockResolvedValue([]),
    _selectFn: selectFn,
    _where: where,
    _limitFn: limitFn,
  };
}

describe("HrCasesService – actor contraction dual-read", () => {
  const mockAudit = { log: jest.fn() };

  const baseListInput: ListCasesInput = {
    limit: 20,
    cursor: undefined,
    status: undefined,
    category: undefined,
    severity: undefined,
    search: undefined,
    assignedTo: undefined,
  };

  describe("list() visibility predicate", () => {
    it("emits assignedToMembershipId predicate when membershipId is provided", async () => {
      const row = makeCase();
      const mockDb = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([row]),
              }),
            }),
          }),
        }),
        execute: jest.fn().mockResolvedValue([]),
      } as unknown as Parameters<typeof HrCasesService.prototype.list>[0];

      const service = new HrCasesService(mockDb as never, mockAudit as never);

      const result = await service.list(
        ORG_ID,
        MEMBER_USER_ID,
        false,
        baseListInput,
        ACTIVE_MEMBERSHIP_ID,
      );

      expect(result.data).toHaveLength(1);
      expect(result.pagination.hasMore).toBe(false);
    });

    it("falls back to userId-only predicate when membershipId is null", async () => {
      const row = makeCase();
      const mockDb = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([row]),
              }),
            }),
          }),
        }),
        execute: jest.fn().mockResolvedValue([]),
      } as unknown as Parameters<typeof HrCasesService.prototype.list>[0];

      const service = new HrCasesService(mockDb as never, mockAudit as never);

      const result = await service.list(
        ORG_ID,
        MEMBER_USER_ID,
        false,
        baseListInput,
        null,
      );

      expect(result.data).toHaveLength(1);
    });
  });

  describe("getById() confidential gate", () => {
    it("grants access when assignedToMembershipId matches the actor", async () => {
      const row = makeCase({ confidential: true, assignedToMembershipId: ACTIVE_MEMBERSHIP_ID });
      const mockDb = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([row]),
            }),
          }),
        }),
      } as unknown as Parameters<typeof HrCasesService.prototype.getById>[0];

      const service = new HrCasesService(mockDb as never, mockAudit as never);

      const result = await service.getById(ORG_ID, 1, MEMBER_USER_ID, false, ACTIVE_MEMBERSHIP_ID);
      expect(result).toMatchObject({ id: 1 });
    });

    it("denies access when membershipId does not match and user is not assignee", async () => {
      const row = makeCase({
        confidential: true,
        assignedTo: MEMBER_USER_ID,
        assignedToMembershipId: ACTIVE_MEMBERSHIP_ID,
      });
      const mockDb = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([row]),
            }),
          }),
        }),
      } as unknown as Parameters<typeof HrCasesService.prototype.getById>[0];

      const service = new HrCasesService(mockDb as never, mockAudit as never);

      const OTHER_USER = "user-other";
      await expect(
        service.getById(ORG_ID, 1, OTHER_USER, false, REVOKED_MEMBERSHIP_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("denies access when row has membershipId populated but actor membership no longer matches (revoked member)", async () => {
      const row = makeCase({
        confidential: true,
        assignedTo: MEMBER_USER_ID,
        assignedToMembershipId: ACTIVE_MEMBERSHIP_ID,
      });
      const mockDb = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([row]),
            }),
          }),
        }),
      } as unknown as Parameters<typeof HrCasesService.prototype.getById>[0];

      const service = new HrCasesService(mockDb as never, mockAudit as never);

      await expect(
        service.getById(ORG_ID, 1, "other-user-id", false, REVOKED_MEMBERSHIP_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("throws NotFoundException for missing case", async () => {
      const mockDb = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as unknown as Parameters<typeof HrCasesService.prototype.getById>[0];

      const service = new HrCasesService(mockDb as never, mockAudit as never);

      await expect(
        service.getById(ORG_ID, 999, MEMBER_USER_ID, false, ACTIVE_MEMBERSHIP_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
