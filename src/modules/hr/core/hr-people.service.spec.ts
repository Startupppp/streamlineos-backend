import { ConflictException } from "@nestjs/common";
import { HrPeopleService } from "./hr-people.service";

function selectChain(result: unknown[]) {
  const chain: {
    from: jest.Mock;
    innerJoin: jest.Mock;
    where: jest.Mock;
    limit: jest.Mock;
  } = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
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

function updateChain() {
  return {
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue([]),
    }),
  };
}

const PERSON_VIEW = {
  id: 5,
  orgId: "org-1",
  userId: null,
  organizationPersonId: "op-existing",
  firstName: "Ada",
  lastName: "Lovelace",
  workEmail: "ada@example.com",
  phone: null,
  gender: null,
  avatarUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

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
        .mockReturnValueOnce(selectChain([{ organizationPersonId: "op-existing" }]))
        .mockReturnValueOnce(selectChain([{ ...PERSON_VIEW, id: 5 }])),
      insert: jest.fn().mockImplementation(() => {
        insertCall += 1;
        return insertChainWithCatch([{ id: 5 }]);
      }),
      update: jest.fn().mockReturnValue(updateChain()),
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
        .mockReturnValueOnce(selectChain([]))
        .mockReturnValueOnce(selectChain([{ ...PERSON_VIEW, id: 6, organizationPersonId: "op-new" }])),
      insert: jest.fn().mockImplementation(() => {
        insertCall += 1;
        if (insertCall === 1)
          return insertChain([{ organizationPersonId: "op-new" }]);
        return insertChainWithCatch([{ id: 6 }]);
      }),
      update: jest.fn().mockReturnValue(updateChain()),
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
      update: jest.fn().mockReturnValue(updateChain()),
    };
    const audit = { log: jest.fn() };
    const service = new HrPeopleService(db as never, audit as never);

    await expect(service.create("org-1", "actor-1", input)).rejects.toBeInstanceOf(ConflictException);
  });
});
