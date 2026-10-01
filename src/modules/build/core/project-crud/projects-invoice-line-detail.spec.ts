import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { ProjectsWriteService } from "./projects-write.service";
import { ProjectsController } from "../projects.controller";
import { REQUIRE_PERMISSION } from "../../../../common/rbac/require-permission-key";
import { VALIDATION_SCHEMAS } from "../../../../common/validation/validate.decorator";
import {
  projectInvoiceLineDetailSchema,
  updateProjectSchema,
} from "../dto/projects.schemas";
import { projectIdParams } from "../dto/build-params.schemas";
import { MANAGER_STANDING, projectAccessRow, standingAccess, type ProjectAccessRow } from "./__tests__/project-access-doubles";

const ORG = "org-line-detail";

const owner = {
  orgId: ORG,
  userId: "owner-user",
  isOrgOwner: true,
  principal: {
    kind: "human-session" as const,
    membershipId: 7,
    isOrgOwner: true,
  },
} as never;

function makeDb(
  projectRow: ProjectAccessRow | null,
  settingRows: Array<{ invoiceLineDetail: "summary" | "raw" }>,
) {
  const rowsFor = (rows: unknown[]) => {
    const limit = jest.fn().mockResolvedValue(rows);
    const where = jest.fn(() => ({ limit }));
    return { from: jest.fn(() => ({ where })) };
  };
  const select = jest
    .fn()
    .mockImplementationOnce(() => rowsFor(projectRow ? [projectRow] : []))
    .mockImplementation(() => rowsFor(settingRows));
  const update = jest.fn();
  return {
    db: {
      query: {
        organizationMembers: { findFirst: jest.fn() },
      },
      select,
      update,
      transaction: jest.fn(
        async (fn: (tx: unknown) => Promise<unknown>) =>
          await fn({
            update: jest.fn(() => ({
              set: updateSet,
              where: jest.fn(),
            })),
          }),
      ),
    } as unknown as Db,
    select,
  };
}

const updateSet = jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) }));

function makeService(db: Db, getProject = jest.fn()) {
  return new ProjectsWriteService(
    db,
    { log: jest.fn() } as never,
    standingAccess(MANAGER_STANDING) as never,
    { getProject } as never,
  );
}

describe("project invoice line detail exposure", () => {
  beforeEach(() => {
    updateSet.mockClear();
  });

  describe("the boundary schema", () => {
    it("accepts both labels the database enum actually holds, so the contract cannot drift from the column", () => {
      expect(
        updateProjectSchema.safeParse({ invoiceLineDetail: "summary" }).success,
      ).toBe(true);
      expect(
        updateProjectSchema.safeParse({ invoiceLineDetail: "raw" }).success,
      ).toBe(true);
    });

    it("rejects a value the enum does not hold rather than writing it and failing at the database", () => {
      expect(
        updateProjectSchema.safeParse({ invoiceLineDetail: "verbatim" }).success,
      ).toBe(false);
    });

    it("rejects a misspelled key rather than stripping it, which would silently leave the project on summary", () => {
      expect(
        updateProjectSchema.safeParse({ invoiceLineDetails: "raw" }).success,
      ).toBe(false);
    });

    it("declares the route param so the strict params schema cannot 400 every call", () => {
      expect(projectIdParams.safeParse({ projectId: "12" }).success).toBe(true);
      expect(projectIdParams.safeParse({}).success).toBe(false);
    });

    it("publishes the resolved value, not a bare string, on the read contract", () => {
      expect(
        projectInvoiceLineDetailSchema.safeParse({
          projectId: 12,
          invoiceLineDetail: "raw",
        }).success,
      ).toBe(true);
      expect(
        projectInvoiceLineDetailSchema.safeParse({
          projectId: 12,
          invoiceLineDetail: "anything",
        }).success,
      ).toBe(false);
    });
  });

  describe("reading the setting", () => {
    it("answers the project's stored value for a caller who can reach the project", async () => {
      const { db } = makeDb(projectAccessRow({ manages: true }), [
        { invoiceLineDetail: "raw" },
      ]);

      await expect(
        makeService(db).getInvoiceLineDetail(owner, 12),
      ).resolves.toEqual({ projectId: 12, invoiceLineDetail: "raw" });
    });

    it("answers summary for a project that never touched the setting, because the column default is what the read returns", async () => {
      const { db } = makeDb(projectAccessRow({ manages: true }), [
        { invoiceLineDetail: "summary" },
      ]);

      await expect(
        makeService(db).getInvoiceLineDetail(owner, 12),
      ).resolves.toEqual({ projectId: 12, invoiceLineDetail: "summary" });
    });

    it("answers 404 and never 403 for a project id that belongs to another organization, because 403 would confirm it exists", async () => {
      const { db, select } = makeDb(null, []);
      const service = makeService(db);

      const attempt = service.getInvoiceLineDetail(owner, 9999);
      await expect(attempt).rejects.toThrow(NotFoundException);
      await expect(attempt).rejects.not.toThrow(ForbiddenException);
      expect(select).toHaveBeenCalledTimes(1);
    });
  });

  describe("writing the setting", () => {
    it("persists the chosen value on the project row", async () => {
      const { db } = makeDb(projectAccessRow({ manages: true }), []);
      const getProject = jest.fn().mockResolvedValue({ id: 12 });

      await makeService(db, getProject).updateProject(owner, 12, {
        invoiceLineDetail: "raw",
      });

      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceLineDetail: "raw" }),
      );
    });

    it("leaves the stored value untouched when the caller sends an update that does not mention it", async () => {
      const { db } = makeDb(projectAccessRow({ manages: true }), []);
      const getProject = jest.fn().mockResolvedValue({ id: 12 });

      await makeService(db, getProject).updateProject(owner, 12, {
        name: "Renamed",
      });

      expect(updateSet).toHaveBeenCalledWith(
        expect.not.objectContaining({ invoiceLineDetail: expect.anything() }),
      );
    });
  });

  describe("the route", () => {
    const handler = ProjectsController.prototype.getInvoiceLineDetail;

    it("is gated on the project-view key that already exists in both catalogs, rather than a key invented for this setting", () => {
      expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBe(
        "build:view",
      );
    });

    it("parses its route param through the strict params schema rather than trusting the path", () => {
      expect(Reflect.getMetadata(VALIDATION_SCHEMAS, handler)).toEqual({
        params: projectIdParams,
      });
    });
  });
});
