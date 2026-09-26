import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbMembersService } from "./kb-members.service";
import type { KbAccessService } from "../core/kb-access.service";
import type { KbIndexingService } from "../retrieval/kb-indexing.service";

const dialect = new PgDialect();

const ORG = "org-role-grant";
const SPACE_ID = 5;

function harness(knownSlugs: string[]) {
  const roleWhere = jest.fn();
  const rolesLimit = jest.fn();
  const values = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([{ id: 1, role: null }]),
  });
  const insert = jest.fn().mockReturnValue({ values });

  const from = jest.fn().mockReturnValue({
    leftJoin: jest.fn().mockReturnValue({
      leftJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ id: 1 }]),
      }),
    }),
    where: (cond: SQL) => {
      roleWhere(cond);
      const params = dialect.sqlToQuery(cond).params as unknown[];
      const slug = String(params[params.length - 1]);
      const org = String(params[0]);
      return {
        limit: rolesLimit.mockResolvedValue(
          org === ORG && knownSlugs.includes(slug) ? [{ slug }] : [],
        ),
      };
    },
  });

  const db = {
    query: {
      kbSpaces: { findFirst: jest.fn().mockResolvedValue({ id: SPACE_ID }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 11 }) },
    },
    select: jest.fn().mockReturnValue({ from }),
    insert,
  } as unknown as Db;

  const service = new KbMembersService(
    db,
    { invalidateAccessibleSpaceIds: jest.fn() } as unknown as KbAccessService,
    { bumpSpaceAclRevision: jest.fn() } as unknown as KbIndexingService,
  );
  return { service, insert, values, roleWhere, rolesLimit };
}

describe("KbMembersService.add — a role grant names a role that exists", () => {
  it("BITE: refuses an unknown slug instead of storing a grant that matches nobody", async () => {
    const h = harness(["engineer"]);

    await expect(
      h.service.add(ORG, SPACE_ID, { role: "enginer", spaceRole: "editor" }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(h.insert).not.toHaveBeenCalled();
  });

  it("positive control: a slug the org actually defines is stored", async () => {
    const h = harness(["engineer"]);

    await h.service.add(ORG, SPACE_ID, { role: "engineer", spaceRole: "editor" });

    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.values).toHaveBeenCalledWith(
      expect.objectContaining({ role: "engineer", membershipId: null }),
    );
  });

  it("reports the unknown slug the same way an unknown user is reported, so neither path fails silently", async () => {
    const h = harness([]);

    await expect(
      h.service.add(ORG, SPACE_ID, { role: "ghost", spaceRole: "viewer" }),
    ).rejects.toMatchObject({ message: "Role not found" });
  });

  it("scopes the lookup to the acting org, so another tenant's slug cannot be granted", async () => {
    const h = harness(["engineer"]);

    await expect(
      h.service.add("org-intruder", SPACE_ID, { role: "engineer", spaceRole: "editor" }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const cond = h.roleWhere.mock.calls[0]?.[0] as SQL;
    const { sql, params } = dialect.sqlToQuery(cond);
    expect(sql).toContain('"org_id"');
    expect(sql).toContain('"slug"');
    expect(params).toContain("org-intruder");
  });

  it("bounds the catalog probe to a single row rather than loading every role in the org", async () => {
    const h = harness(["engineer"]);

    await h.service.add(ORG, SPACE_ID, { role: "engineer", spaceRole: "editor" });

    expect(h.rolesLimit).toHaveBeenCalledWith(1);
  });

  it("does not consult the role catalog when the grant names a user", async () => {
    const h = harness(["engineer"]);

    await h.service.add(ORG, SPACE_ID, { userId: "user-1", spaceRole: "viewer" });

    expect(h.roleWhere).not.toHaveBeenCalled();
    expect(h.insert).toHaveBeenCalledTimes(1);
  });
});
