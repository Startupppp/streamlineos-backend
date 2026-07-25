import { RolesService } from "../roles.service";

const actor = { orgId: "org-1", userId: "user-1" };

function createService(existingSlugs: string[]) {
  const service = Object.create(RolesService.prototype) as RolesService;
  const findFirst = jest.fn().mockImplementation(({ where: _where }: { where: unknown }) =>
    Promise.resolve(undefined),
  );
  Reflect.set(service, "db", { query: { roles: { findFirst } } });

  const seen: string[] = [];
  findFirst.mockImplementation(() => {
    const slugOrder = [
      "ENGINEERING",
      "SALES_REP",
      "CUSTOMER_SUPPORT",
      "DIGITAL_MARKETING",
      "HR_ADMIN",
      "ACCOUNTANT",
    ];
    const slug = slugOrder[seen.length] ?? "";
    seen.push(slug);
    return Promise.resolve(existingSlugs.includes(slug) ? { id: 1 } : undefined);
  });

  const cloneTemplate = jest.fn().mockResolvedValue({ id: 2 });
  Reflect.set(service, "cloneTemplate", cloneTemplate);
  return { service, cloneTemplate };
}

describe("RolesService.seedDefaultRoles", () => {
  it("creates the starter roles that are missing and skips existing ones", async () => {
    const { service, cloneTemplate } = createService(["ENGINEERING", "HR_ADMIN"]);

    const result = await service.seedDefaultRoles(actor as never);

    expect(result.skipped).toEqual(["ENGINEERING", "HR_ADMIN"]);
    expect(result.created).toEqual([
      "SALES_REP",
      "CUSTOMER_SUPPORT",
      "DIGITAL_MARKETING",
      "ACCOUNTANT",
    ]);
    expect(cloneTemplate).toHaveBeenCalledTimes(4);
    expect(cloneTemplate).toHaveBeenCalledWith(actor, { templateId: "sales_rep" });
  });

  it("is a no-op when every starter role already exists", async () => {
    const { service, cloneTemplate } = createService([
      "ENGINEERING",
      "SALES_REP",
      "CUSTOMER_SUPPORT",
      "DIGITAL_MARKETING",
      "HR_ADMIN",
      "ACCOUNTANT",
    ]);

    const result = await service.seedDefaultRoles(actor as never);

    expect(result.created).toEqual([]);
    expect(result.skipped).toHaveLength(6);
    expect(cloneTemplate).not.toHaveBeenCalled();
  });
});
