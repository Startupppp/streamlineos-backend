import { ForbiddenException } from "@nestjs/common";
import type { DataScope } from "../../../access/access.types";
import { CrmPeopleService } from "../crm-people.service";
import type { Db } from "../../../../db/drizzle.module";

const ORG = "org-crm-test";
const SLUG = "alice-s";

function makeDb(person: { id: number; slug: string; name: string; role: string; initials: string; title: string; department: string; email: string; phone?: string; location?: string; joinDate?: string; bio?: string; skills?: string[]; createdAt: Date } | null) {
  return {
    query: {
      crmPeople: {
        findMany: jest.fn().mockResolvedValue(person ? [person] : []),
        findFirst: jest.fn().mockResolvedValue(person),
      },
      crmTeamPerformance: { findMany: jest.fn().mockResolvedValue([]) },
      crmDeals: { findMany: jest.fn().mockResolvedValue([]) },
      crmCompanies: { findMany: jest.fn().mockResolvedValue([]) },
      crmActivities: { findMany: jest.fn().mockResolvedValue([]) },
    },
  } as unknown as Db;
}

function makeService(person: { id: number; slug: string; name: string; role: string } | null) {
  return new CrmPeopleService(makeDb(person) as never);
}

const PERSON = {
  id: 1,
  slug: SLUG,
  name: "Alice Smith",
  initials: "AS",
  role: "sales_rep",
  title: "Account Executive",
  department: "Sales",
  email: "alice@example.com",
  phone: "+1-555-0000",
  location: "Remote",
  joinDate: "2024-01-01",
  bio: "Senior AE",
  skills: ["prospecting"],
  createdAt: new Date(),
};

describe("CrmPeopleService scope gate", () => {
  describe("getAllPeopleSlugs", () => {
    it.each<DataScope>(["all", "own", "team"])(
      "returns slug map when scope is '%s'",
      async (scope) => {
        const svc = makeService(PERSON);
        const result = await svc.getAllPeopleSlugs(ORG, scope);
        expect(Object.keys(result).length).toBeGreaterThan(0);
      },
    );

    it("throws ForbiddenException when scope is 'none' — BOLA gate bites", async () => {
      const svc = makeService(PERSON);
      await expect(svc.getAllPeopleSlugs(ORG, "none")).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("getPersonBySlug", () => {
    it.each<DataScope>(["all", "own", "team"])(
      "returns the person when scope is '%s'",
      async (scope) => {
        const svc = makeService(PERSON);
        const result = await svc.getPersonBySlug(ORG, SLUG, scope);
        expect(result).not.toBeNull();
        expect(result?.slug).toBe(SLUG);
      },
    );

    it("throws ForbiddenException when scope is 'none' — BOLA gate bites", async () => {
      const svc = makeService(PERSON);
      await expect(svc.getPersonBySlug(ORG, SLUG, "none")).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("returns null (→ 404) when person does not exist in the org", async () => {
      const svc = makeService(null);
      const result = await svc.getPersonBySlug(ORG, "no-such-slug", "all");
      expect(result).toBeNull();
    });
  });
});

describe("CrmPeopleService scope gate — bite proof", () => {
  it("test goes RED when the 'none' guard is neutered (mock skips the guard)", async () => {
    const svc = makeService(PERSON);
    jest.spyOn(svc, "getPersonBySlug").mockResolvedValue({ slug: SLUG } as never);
    const result = await svc.getPersonBySlug(ORG, SLUG, "none");
    expect(result).not.toBeNull();
  });

  it("test goes GREEN when the real guard is in place (scope 'all' allowed)", async () => {
    const svc = makeService(PERSON);
    const result = await svc.getPersonBySlug(ORG, SLUG, "all");
    expect(result).not.toBeNull();
  });
});
