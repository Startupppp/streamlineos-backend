import { ConflictException, NotFoundException } from "@nestjs/common";
import { CyclesService } from "./cycles.service";
import { drizzlePostgresError } from "../../../test/postgres-error-fixture";
import type { Db } from "../../../db/drizzle.module";
import { cycleStatusEnum } from "../../../db/schema/common/enums";

const ORG_ID = "org-cycle-62";
const PROJECT_ID = 9;
const CYCLE_ID = 7;
const USER_ID = "user-1";

const CREATE_INPUT = { name: "Q4 Sprint", startDate: "2026-10-01", endDate: "2026-10-14" };
const UPDATE_INPUT_ACTIVE = { status: "active" as const, version: 1, startDate: undefined, endDate: undefined };
const UPDATE_INPUT_DATES = { startDate: "2026-10-01", endDate: "2026-10-14", version: 1 };

type CycleRowStatus = (typeof cycleStatusEnum.enumValues)[number];

type CycleRow = {
  id: number;
  orgId: string;
  projectId: number;
  name: string;
  description: string | null;
  goal: string | null;
  status: CycleRowStatus;
  startDate: string;
  endDate: string;
  createdBy: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const CYCLE_ROW: CycleRow = {
  id: CYCLE_ID,
  orgId: ORG_ID,
  projectId: PROJECT_ID,
  name: "Q4 Sprint",
  description: null,
  goal: null,
  status: "draft",
  startDate: "2026-10-01",
  endDate: "2026-10-14",
  createdBy: USER_ID,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function exclusionViolation(): unknown {
  return drizzlePostgresError("23P01", "excl_cycles_no_date_overlap", "conflicting key value violates exclusion constraint");
}

function uniqueViolation(): unknown {
  return drizzlePostgresError("23505", "uniq_cycles_one_active_per_project", "duplicate key value violates unique constraint");
}

function makeSelectEmpty() {
  return jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn(() => ({
        limit: jest.fn().mockResolvedValue([]),
      })),
    })),
  }));
}

function makeInsertError(error: unknown) {
  return jest.fn(() => ({
    values: jest.fn(() => ({
      returning: jest.fn().mockRejectedValue(error),
    })),
  }));
}

function makeInsertSuccess() {
  return jest.fn(() => ({
    values: jest.fn(() => ({
      returning: jest.fn().mockResolvedValue([CYCLE_ROW]),
    })),
  }));
}

function makeUpdateError(error: unknown) {
  return jest.fn(() => ({
    set: jest.fn(() => ({
      where: jest.fn(() => ({
        returning: jest.fn().mockRejectedValue(error),
      })),
    })),
  }));
}

function makeUpdateSuccess(rows: CycleRow[] = [CYCLE_ROW]) {
  return jest.fn(() => ({
    set: jest.fn(() => ({
      where: jest.fn(() => ({
        returning: jest.fn().mockResolvedValue(rows),
      })),
    })),
  }));
}

function projectOk() {
  return jest.fn().mockResolvedValue({ id: PROJECT_ID });
}

function cycleOk() {
  return jest.fn().mockResolvedValue({ version: 1 });
}

function makeService(db: Db): CyclesService {
  return new CyclesService(db as never);
}

describe("CyclesService — constraint violation translation", () => {
  describe("createCycle", () => {
    it("translates an exclusion violation into the date-overlap conflict message the app check uses, so the race-losing concurrent creator sees the same error the sequential path produces", async () => {
      const db = {
        select: makeSelectEmpty(),
        insert: makeInsertError(exclusionViolation()),
        query: { projects: { findFirst: projectOk() } },
      } as unknown as Db;

      await expect(
        makeService(db).createCycle(ORG_ID, USER_ID, PROJECT_ID, CREATE_INPUT),
      ).rejects.toThrow(ConflictException);

      await expect(
        makeService(db).createCycle(ORG_ID, USER_ID, PROJECT_ID, CREATE_INPUT),
      ).rejects.toThrow("Cycle dates overlap with an existing cycle.");
    });

    it("positive control: a successful insert returns the new cycle row", async () => {
      const db = {
        select: makeSelectEmpty(),
        insert: makeInsertSuccess(),
        query: { projects: { findFirst: projectOk() } },
      } as unknown as Db;

      const result = await makeService(db).createCycle(ORG_ID, USER_ID, PROJECT_ID, CREATE_INPUT);
      expect(result).toMatchObject({ id: CYCLE_ID });
    });

    it("re-throws unrelated database errors without translating them, so unexpected failures still surface as 500", async () => {
      const unrelated = new Error("connection reset");
      const db = {
        select: makeSelectEmpty(),
        insert: makeInsertError(unrelated),
        query: { projects: { findFirst: projectOk() } },
      } as unknown as Db;

      await expect(
        makeService(db).createCycle(ORG_ID, USER_ID, PROJECT_ID, CREATE_INPUT),
      ).rejects.toThrow("connection reset");
    });
  });

  describe("updateCycle — activating a cycle", () => {
    it("translates a unique violation into the single-active conflict message the app check uses, so the race-losing concurrent activator sees the same error the sequential path produces", async () => {
      const db = {
        select: makeSelectEmpty(),
        update: makeUpdateError(uniqueViolation()),
        query: { projects: { findFirst: projectOk() }, cycles: { findFirst: cycleOk() } },
      } as unknown as Db;

      await expect(
        makeService(db).updateCycle(ORG_ID, PROJECT_ID, CYCLE_ID, UPDATE_INPUT_ACTIVE),
      ).rejects.toThrow(ConflictException);

      await expect(
        makeService(db).updateCycle(ORG_ID, PROJECT_ID, CYCLE_ID, UPDATE_INPUT_ACTIVE),
      ).rejects.toThrow("Only one active cycle is allowed at a time per project.");
    });

    it("positive control: a successful activation returns the updated cycle", async () => {
      const active: CycleRow = { ...CYCLE_ROW, status: "active" };
      const db = {
        select: makeSelectEmpty(),
        update: makeUpdateSuccess([active]),
        query: { projects: { findFirst: projectOk() }, cycles: { findFirst: cycleOk() } },
      } as unknown as Db;

      const result = await makeService(db).updateCycle(ORG_ID, PROJECT_ID, CYCLE_ID, UPDATE_INPUT_ACTIVE);
      expect(result).toMatchObject({ status: "active" });
    });
  });

  describe("updateCycle — changing dates", () => {
    it("translates an exclusion violation into the date-overlap conflict message, so a concurrent date change that races past the app check returns the same error", async () => {
      const db = {
        select: makeSelectEmpty(),
        update: makeUpdateError(exclusionViolation()),
        query: { projects: { findFirst: projectOk() }, cycles: { findFirst: cycleOk() } },
      } as unknown as Db;

      await expect(
        makeService(db).updateCycle(ORG_ID, PROJECT_ID, CYCLE_ID, UPDATE_INPUT_DATES),
      ).rejects.toThrow(ConflictException);

      await expect(
        makeService(db).updateCycle(ORG_ID, PROJECT_ID, CYCLE_ID, UPDATE_INPUT_DATES),
      ).rejects.toThrow("Cycle dates overlap with an existing cycle.");
    });

    it("throws NotFoundException when the cycle row is absent, so a missing cycle is still 404 and not mistaken for a constraint violation", async () => {
      const db = {
        select: makeSelectEmpty(),
        update: makeUpdateSuccess([]),
        query: { projects: { findFirst: projectOk() }, cycles: { findFirst: jest.fn().mockResolvedValue(undefined) } },
      } as unknown as Db;

      await expect(
        makeService(db).updateCycle(ORG_ID, PROJECT_ID, CYCLE_ID, UPDATE_INPUT_DATES),
      ).rejects.toThrow(NotFoundException);
    });

    it("re-throws unrelated database errors without translating them, so unexpected failures still surface as 500", async () => {
      const unrelated = new Error("deadlock detected");
      const db = {
        select: makeSelectEmpty(),
        update: makeUpdateError(unrelated),
        query: { projects: { findFirst: projectOk() }, cycles: { findFirst: cycleOk() } },
      } as unknown as Db;

      await expect(
        makeService(db).updateCycle(ORG_ID, PROJECT_ID, CYCLE_ID, UPDATE_INPUT_DATES),
      ).rejects.toThrow("deadlock detected");
    });
  });
});
