import { ConflictException } from "@nestjs/common";
import { HrDepartmentsService } from "./hr-departments.service";
import { departmentItemSchema } from "./dto/config-response.schemas";

/**
 * V-033. `POST /hr/departments` declares `@ResponseSchema(departmentItemSchema)`
 * and returns `{ id, name }` built from whatever `OrgHierarchyService.create
 * Department` hands back — but nothing ever RAN that contract. A projection
 * change that dropped the id, or returned it as a number, would reproduce the
 * original "expected string, received undefined" with no failing test anywhere:
 * the declaration documents the shape, it does not check it.
 *
 * So the assertion here is `departmentItemSchema.parse(result)`, not a deep
 * equality on a literal. Equality would pass just as happily on a shape the
 * route cannot actually serve.
 */
describe("HrDepartmentsService.create", () => {
  const ORG = "org-1";
  const USER = "user-1";

  function serviceWith(createDepartment: jest.Mock) {
    return new HrDepartmentsService({ createDepartment } as never);
  }

  it("returns a string id and the trimmed name for a newly created department", async () => {
    const createDepartment = jest
      .fn()
      .mockResolvedValue({ id: "unit-9", name: "Engineering", code: "ENGINEERING" });

    const result = await serviceWith(createDepartment).create(ORG, USER, "  Engineering  ");

    expect(() => departmentItemSchema.parse(result)).not.toThrow();
    expect(result).toEqual({ id: "unit-9", name: "Engineering" });
    // The trim is the service's, not the caller's: the name reaching the
    // hierarchy is what gets stored and what every later lookup matches on.
    expect(createDepartment).toHaveBeenCalledWith(ORG, USER, {
      name: "Engineering",
      code: "ENGINEERING",
    });
  });

  it("retries a colliding code and still returns a string id", async () => {
    // Two departments whose names normalise to the same code is ordinary, not
    // exceptional — "Sales" and "sales." — and the retry is the only reason the
    // second one is creatable at all. The contract has to hold on that path too.
    const createDepartment = jest
      .fn()
      .mockRejectedValueOnce(new ConflictException("code already in use"))
      .mockResolvedValueOnce({ id: "unit-12", name: "Sales" });

    const result = await serviceWith(createDepartment).create(ORG, USER, "Sales");

    expect(() => departmentItemSchema.parse(result)).not.toThrow();
    expect(result).toEqual({ id: "unit-12", name: "Sales" });
    expect(createDepartment.mock.calls.map((call) => call[2].code)).toEqual([
      "SALES",
      "SALES2",
    ]);
  });

  it("fails the contract when the hierarchy returns no id, instead of serving undefined", async () => {
    // The original defect, reproduced: a projection that drops the id used to
    // reach the client as `{ id: undefined }` and 500 at the response schema
    // with nothing pointing back here.
    const result = await serviceWith(
      jest.fn().mockResolvedValue({ name: "Support" }),
    ).create(ORG, USER, "Support");

    expect(() => departmentItemSchema.parse(result)).toThrow();
  });

  it("gives up after five colliding codes rather than looping", async () => {
    const createDepartment = jest
      .fn()
      .mockRejectedValue(new ConflictException("code already in use"));

    await expect(serviceWith(createDepartment).create(ORG, USER, "Ops")).rejects.toThrow(
      ConflictException,
    );
    expect(createDepartment).toHaveBeenCalledTimes(5);
  });

  it("rethrows a non-conflict failure instead of burning a retry on it", async () => {
    const createDepartment = jest.fn().mockRejectedValue(new Error("connection lost"));

    await expect(serviceWith(createDepartment).create(ORG, USER, "Ops")).rejects.toThrow(
      "connection lost",
    );
    expect(createDepartment).toHaveBeenCalledTimes(1);
  });
});
