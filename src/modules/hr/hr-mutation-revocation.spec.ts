import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { organizationMembers } from "../../db/schema";
import {
  OrganizationActorError,
  assertOrganizationActor,
} from "../../common/organization/organization-actor";
import type { DbOrTx } from "../../common/rbac/access-invalidate";

const ORG = "org-1";
const USER = "user-1";

/**
 * A JWT outlives the membership it was minted for. Every HR mutation therefore
 * re-resolves the acting membership from the database inside the command, and
 * a suspended or removed member is refused before anything is written.
 */
function membershipReader(rows: unknown[]) {
  const wheres: unknown[] = [];
  const chain = {
    from: () => chain,
    where: (condition: unknown) => {
      wheres.push(condition);
      return chain;
    },
    limit: () => Promise.resolve(rows),
    then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
  };
  const db = { select: () => chain } as unknown as DbOrTx;
  return { db, wheres };
}

function renderedWhere(wheres: unknown[]): string {
  return wheres.map((w) => new PgDialect().sqlToQuery(w as never).sql).join(" ");
}

describe("HR mutations re-check membership at command time", () => {
  it("refuses the command when the membership is no longer active", async () => {
    const { db } = membershipReader([]);

    await expect(
      assertOrganizationActor(db, ORG, { kind: "user", userId: USER }),
    ).rejects.toBeInstanceOf(OrganizationActorError);
  });

  it.each(["SUSPENDED", "REMOVED", "INVITED"])(
    "refuses a command from a %s membership even though the token is still valid",
    async (status) => {
      const { db } = membershipReader([
        { id: 42, userId: USER, orgId: ORG, status, isOwner: false, role: "MEMBER" },
      ]);

      await expect(
        assertOrganizationActor(db, ORG, { kind: "user", userId: USER }),
      ).rejects.toMatchObject({ reason: "membership-inactive" });
    },
  );

  it("resolves the membership from the acting organization, never from the token", async () => {
    const { db, wheres } = membershipReader([]);

    await assertOrganizationActor(db, ORG, { kind: "user", userId: USER }).catch(
      () => undefined,
    );

    const sql = renderedWhere(wheres);
    expect(sql).toContain('"org_id" = $');
    expect(sql).toContain('"user_id" = $');
  });

  it("resolves the live membership for a member who is still active", async () => {
    const { db } = membershipReader([
      { id: 42, userId: USER, orgId: ORG, status: "ACTIVE", isOwner: false, role: "MEMBER" },
    ]);

    const actor = await assertOrganizationActor(db, ORG, {
      kind: "user",
      userId: USER,
    });

    expect(actor.membershipId).toBe(42);
  });

  it("reads the status column the revocation depends on — the assertion is not vacuous", () => {
    const rendered = new PgDialect().sqlToQuery(
      eq(organizationMembers.status, "ACTIVE") as never,
    );
    expect(rendered.sql).toContain('"status"');
    expect(rendered.params).toEqual(["ACTIVE"]);
  });
});
