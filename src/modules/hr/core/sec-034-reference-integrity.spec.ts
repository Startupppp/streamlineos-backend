import { BadRequestException, NotFoundException } from "@nestjs/common";
import { upsertCustomFieldValuesSchema } from "./dto/hr-custom-fields.schemas";
import { HrCustomFieldsService } from "./hr-custom-fields.service";
import { HrEmploymentsService } from "./hr-employments.service";
import { WorkerEngagementsService } from "../../directory/worker-engagements.service";
import { assertActiveOrgUnit } from "../../../common/org/sync-org-unit-placement";
import { PgDialect } from "drizzle-orm/pg-core";
import { ScopedRead } from "../../access/scoped-read";

function selectChain(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

describe("SEC-034 reference integrity", () => {
  it("binds org-unit validation to tenant, kind, active status, and non-deleted rows", async () => {
    const chain = selectChain([{ id: "department-1" }]);
    const db = { select: jest.fn().mockReturnValue(chain) };

    await assertActiveOrgUnit(
      db as never,
      "org-1",
      "department-1",
      "DEPARTMENT",
    );

    const compiled = new PgDialect().sqlToQuery(chain.where.mock.calls[0][0]);
    expect(compiled.params).toEqual(
      expect.arrayContaining(["department-1", "org-1", "DEPARTMENT", "ACTIVE"]),
    );
  });

  it("rejects an HR employment person outside the organization", async () => {
    const db = {
      select: jest.fn().mockReturnValue(selectChain([])),
      insert: jest.fn(),
    };
    const service = new HrEmploymentsService(db as never, {} as never);

    await expect(
      service.create("org-1", "actor-1", {
        personId: 99,
        employeeNumber: "EMP-99",
        lifecycleStatus: "ACTIVE",
        workerType: "FULL_TIME",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rejects a location that is not an active LOCATION in the tenant", async () => {
    const db = {
      query: {
        hrEmployments: {
          findFirst: jest.fn().mockResolvedValue({ id: 7, employeeNumber: "EMP-7" }),
        },
      },
      select: jest.fn().mockReturnValue(selectChain([])),
      update: jest.fn(),
    };
    const service = new HrEmploymentsService(db as never, {} as never);

    await expect(
      service.update("org-1", 7, "actor-1", {
        locationId: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("fails closed for the legacy numeric employment-type reference", async () => {
    const db = {
      query: {
        hrEmployments: {
          findFirst: jest.fn().mockResolvedValue({ id: 7, employeeNumber: "EMP-7" }),
        },
      },
      update: jest.fn(),
    };
    const service = new HrEmploymentsService(db as never, {} as never);

    await expect(
      service.update("org-1", 7, "actor-1", { employmentTypeId: 42 }),
    ).rejects.toThrow("Employment type IDs are not supported");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("does not expose custom-field values for an out-of-scope employment", async () => {
    const db = {
      select: jest.fn().mockReturnValue(selectChain([])),
    };
    const service = new HrCustomFieldsService(db as never);

    await expect(
      service.getEntityValues(ScopedRead.of("org-1", "actor-1", "own"), "employee", "7", false),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects a department reference outside the active tenant catalog", async () => {
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(selectChain([{ id: 7 }]))
        .mockReturnValueOnce(selectChain([])),
      insert: jest.fn(),
    };
    const service = new HrCustomFieldsService(db as never);
    jest.spyOn(service, "listDefinitions").mockResolvedValue([
      {
        id: 5,
        orgId: "org-1",
        entityType: "employee",
        name: "Home department",
        key: "home_department",
        fieldType: "department_ref",
        options: null,
        settings: null,
        isSensitive: false,
        isRequired: false,
        isActive: true,
        displayOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await expect(
      service.upsertEntityValues(
        ScopedRead.of("org-1", "actor-1", "all"),
        "employee",
        "7",
        {
          values: [
            {
              fieldDefinitionId: 5,
              value: "22222222-2222-4222-8222-222222222222",
            },
          ],
        },
        false,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rejects duplicate custom-field IDs before reaching persistence", () => {
    const result = upsertCustomFieldValuesSchema.safeParse({
      values: [
        { fieldDefinitionId: 5, value: "one" },
        { fieldDefinitionId: 5, value: "two" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects self-referential manager engagements before updating", async () => {
    const db = {
      select: jest.fn().mockReturnValue(
        selectChain([
          {
            workerEngagementId: "engagement-1",
            organizationId: "org-1",
            workerId: "worker-1",
            startsOn: "2026-01-01",
            endsOn: null,
          },
        ]),
      ),
      update: jest.fn(),
    };
    const service = new WorkerEngagementsService(db as never, {} as never, {} as never);

    await expect(
      service.updateEngagement("org-1", "actor-1", "engagement-1", {
        expectedVersion: 1,
        managerEngagementId: "engagement-1",
      }),
    ).rejects.toThrow("cannot manage itself");
    expect(db.update).not.toHaveBeenCalled();
  });
});
