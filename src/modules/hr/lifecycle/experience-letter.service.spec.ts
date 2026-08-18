process.env.APP_URL ??= "http://localhost:1000";

import { NotFoundException } from "@nestjs/common";
import { organizationMembers, users } from "../../../db/schema";
import { ExperienceLetterService } from "./experience-letter.service";

function buildSelectChain(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

describe("ExperienceLetterService", () => {
  it("does not create a letter for an arbitrary global user outside the organization", async () => {
    const employeeLookup = buildSelectChain([]);
    const insert = jest.fn();
    const db = {
      query: {
        users: {
          findFirst: jest.fn().mockResolvedValue({
            id: "foreign-user",
            name: "Foreign User",
            joiningDate: "2020-01-01",
            designation: "Global Designation",
          }),
        },
      },
      select: jest.fn().mockReturnValue(employeeLookup),
      insert,
    };
    const service = new ExperienceLetterService(
      db as never,
      { buildContext: jest.fn(), renderHtml: jest.fn() } as never,
    );

    await expect(
      service.create("org-a", "actor-a", {
        userId: "foreign-user",
        relievingDate: "2026-08-31",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(employeeLookup.from).toHaveBeenCalledWith(organizationMembers);
    expect(employeeLookup.innerJoin).toHaveBeenCalledWith(users, expect.anything());
    expect(db.query.users.findFirst).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("uses only tenant employment data after organization membership is proven", async () => {
    const employeeLookup = buildSelectChain([
      {
        userFirstName: "Global",
        userLastName: "Identity",
        userName: "Global Identity",
        directoryFirstName: "Tenant",
        directoryLastName: "Employee",
        legacyFirstName: null,
        legacyLastName: null,
        workforceEmploymentId: "engagement-1",
        legacyEmploymentId: null,
        workforceJoiningDate: "2022-04-01",
        legacyJoiningDate: null,
        workforceDesignation: "Tenant Engineer",
        legacyDesignation: null,
      },
    ]);
    const templateLookup = buildSelectChain([]);
    const returning = jest.fn().mockResolvedValue([
      { id: 73, title: "Experience Certificate - Tenant Employee" },
    ]);
    const values = jest.fn().mockReturnValue({ returning });
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(employeeLookup)
        .mockReturnValueOnce(templateLookup),
      insert: jest.fn().mockReturnValue({ values }),
    };
    const service = new ExperienceLetterService(
      db as never,
      { buildContext: jest.fn(), renderHtml: jest.fn() } as never,
    );

    await expect(
      service.create("org-a", "actor-a", {
        userId: "member-a",
        relievingDate: "2026-08-31",
      }),
    ).resolves.toEqual({
      documentId: 73,
      title: "Experience Certificate - Tenant Employee",
    });

    const inserted = values.mock.calls[0]?.[0] as {
      orgId: string;
      title: string;
      contentJson: unknown;
    };
    const content = JSON.stringify(inserted.contentJson);
    expect(inserted.orgId).toBe("org-a");
    expect(inserted.title).toBe("Experience Certificate - Tenant Employee");
    expect(content).toContain("Tenant Employee");
    expect(content).toContain("Tenant Engineer");
    expect(content).not.toContain("Global Designation");
  });
});
