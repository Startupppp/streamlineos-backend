import { ConflictException } from "@nestjs/common";
import { HrPeopleService } from "./hr-people.service";

function selectChain(result: unknown[]) {
  return {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(result),
      }),
    }),
  };
}

function insertChain(returning: unknown[]) {
  return {
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue(returning),
    }),
  };
}

function insertChainWithCatch(returning: unknown[]) {
  return {
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockReturnValue({
        catch: jest.fn().mockResolvedValue(returning),
      }),
    }),
  };
}

describe("HrPeopleService.create", () => {
  const input = {
    firstName: "Ada",
    lastName: "Lovelace",
    workEmail: "Ada@Example.com",
  };

  it("links to an existing canonical person when the work email already exists in organization_people", async () => {
    let insertCall = 0;
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(selectChain([]))
        .mockReturnValueOnce(selectChain([{ organizationPersonId: "op-existing" }])),
      insert: jest.fn().mockImplementation(() => {
        insertCall += 1;
        return insertChainWithCatch([{
          id: 5,
          orgId: "org-1",
          firstName: "Ada",
          lastName: "Lovelace",
          workEmail: "ada@example.com",
          organizationPersonId: "op-existing",
        }]);
      }),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new HrPeopleService(db as never, audit as never);

    const result = await service.create("org-1", "actor-1", input);

    expect(result.id).toBe(5);
    expect(insertCall).toBe(1);
  });

  it("creates a new canonical person row when none matches the work email", async () => {
    let insertCall = 0;
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(selectChain([]))
        .mockReturnValueOnce(selectChain([])),
      insert: jest.fn().mockImplementation(() => {
        insertCall += 1;
        if (insertCall === 1)
          return insertChain([{ organizationPersonId: "op-new" }]);
        return insertChainWithCatch([{
          id: 6,
          orgId: "org-1",
          firstName: "Ada",
          lastName: "Lovelace",
          workEmail: "ada@example.com",
          organizationPersonId: "op-new",
        }]);
      }),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new HrPeopleService(db as never, audit as never);

    const result = await service.create("org-1", "actor-1", input);

    expect(result.id).toBe(6);
    expect(insertCall).toBe(2);
  });

  it("raises ConflictException when the org_person_link unique constraint fires", async () => {
    const orgPersonLinkError = { code: "23505", constraint: "uniq_hr_people_org_person_link" };
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(selectChain([]))
        .mockReturnValueOnce(selectChain([{ organizationPersonId: "op-1" }])),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn().mockImplementation((handler: (e: unknown) => unknown) =>
              Promise.reject(orgPersonLinkError).catch(handler),
            ),
          }),
        }),
      }),
    };
    const audit = { log: jest.fn() };
    const service = new HrPeopleService(db as never, audit as never);

    await expect(service.create("org-1", "actor-1", input)).rejects.toBeInstanceOf(ConflictException);
  });
});
