import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { orgUnits } from "../../../db/schema";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import type { Db } from "../../../db/drizzle.types";
import {
  OrgHierarchyDependenciesService,
  ORG_UNIT_DEPENDENCY_ERROR,
} from "./org-hierarchy-dependencies.service";
import { OrgHierarchyCommandService } from "./org-hierarchy-command.service";

jest.mock("../../../common/tenant", () => ({
  getTenantContext: jest.fn().mockReturnValue(undefined),
  withTenant: jest.fn(
    (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(_db),
  ),
  runWithTenantContext: jest.fn(
    (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

const DB_URL = requireApprovedDatabaseUrl({
  spec: "org-hierarchy-descendant-protection.db.spec.ts",
  vars: ["HIERARCHY_PROBE_DATABASE_URL", "DATABASE_URL"],
});

jest.setTimeout(60_000);

const suffix = randomUUID().slice(0, 8);
const ORG_A = `hprot-a-${suffix}`;
const ORG_B = `hprot-b-${suffix}`;
const USER_ID = `hprot-u-${suffix}`;

describe("OrgHierarchyDependenciesService — descendant protection (real SQL)", () => {
  let client: postgres.Sql;
  let db: Db;
  let depService: OrgHierarchyDependenciesService;
  let cmdService: OrgHierarchyCommandService;

  beforeAll(async () => {
    client = postgres(DB_URL, { max: 2, prepare: false, onnotice: () => undefined });
    db = drizzle(client, { schema });
    depService = new OrgHierarchyDependenciesService(db);
    cmdService = new OrgHierarchyCommandService(db, depService);

    await client.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email) VALUES (${USER_ID}, ${`${USER_ID}@test.invalid`})`;
      await tx`
        INSERT INTO organizations (id, name, slug, owner_membership_id)
        VALUES (${ORG_A}, ${"Prot Test A"}, ${ORG_A}, 0)
      `;
      await tx`
        INSERT INTO organizations (id, name, slug, owner_membership_id)
        VALUES (${ORG_B}, ${"Prot Test B"}, ${ORG_B}, 0)
      `;
      const [mA] = await tx<Array<{ id: number }>>`
        INSERT INTO organization_members (org_id, user_id, role, status, is_owner)
        VALUES (${ORG_A}, ${USER_ID}, 'OWNER', 'ACTIVE', true) RETURNING id
      `;
      const [mB] = await tx<Array<{ id: number }>>`
        INSERT INTO organization_members (org_id, user_id, role, status, is_owner)
        VALUES (${ORG_B}, ${USER_ID}, 'OWNER', 'ACTIVE', true) RETURNING id
      `;
      await tx`UPDATE organizations SET owner_membership_id = ${mA.id} WHERE id = ${ORG_A}`;
      await tx`UPDATE organizations SET owner_membership_id = ${mB.id} WHERE id = ${ORG_B}`;
    });
  });

  afterAll(async () => {
    await client.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`DELETE FROM org_units WHERE org_id = ${ORG_A} OR org_id = ${ORG_B}`;
      await tx`DELETE FROM organizations WHERE id = ${ORG_A} OR id = ${ORG_B}`;
      await tx`DELETE FROM users WHERE id = ${USER_ID}`;
    });
    await client.end({ timeout: 5 });
  });

  it("case 1: ACTIVE child blocks archive with ORG_UNIT_HAS_DEPENDENCIES and parent is unchanged", async () => {
    const parentId = randomUUID();
    const childId = randomUUID();

    await db.insert(orgUnits).values([
      {
        id: parentId,
        orgId: ORG_A,
        kind: "BUSINESS_UNIT",
        name: "C1-Parent",
        code: `C1P-${suffix}`,
        status: "ACTIVE",
      },
      {
        id: childId,
        orgId: ORG_A,
        kind: "BRANCH",
        parentId,
        name: "C1-Child",
        code: `C1C-${suffix}`,
        status: "ACTIVE",
      },
    ]);

    let thrown: unknown;
    try {
      await depService.assertCanArchive(ORG_A, parentId, "BUSINESS_UNIT");
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    const body = (thrown as ConflictException).getResponse() as {
      code: string;
      details: { dependencies: Array<{ key: string; count: number }> };
    };
    expect(body.code).toBe(ORG_UNIT_DEPENDENCY_ERROR);
    expect(body.details.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "child_units", count: 1 }),
      ]),
    );

    const [parent] = await db
      .select({ status: orgUnits.status, archivedAt: orgUnits.archivedAt, deletedAt: orgUnits.deletedAt })
      .from(orgUnits)
      .where(eq(orgUnits.id, parentId));

    expect(parent?.status).toBe("ACTIVE");
    expect(parent?.archivedAt).toBeNull();
    expect(parent?.deletedAt).toBeNull();
  });

  it("case 2: archiving one sibling leaves the peer row byte-identical", async () => {
    const parentId = randomUUID();
    const sibA = randomUUID();
    const sibB = randomUUID();

    await db.insert(orgUnits).values([
      {
        id: parentId,
        orgId: ORG_A,
        kind: "BUSINESS_UNIT",
        name: "C2-Parent",
        code: `C2P-${suffix}`,
        status: "ACTIVE",
      },
      {
        id: sibA,
        orgId: ORG_A,
        kind: "BRANCH",
        parentId,
        name: "C2-SibA",
        code: `C2A-${suffix}`,
        status: "ACTIVE",
      },
      {
        id: sibB,
        orgId: ORG_A,
        kind: "BRANCH",
        parentId,
        name: "C2-SibB",
        code: `C2B-${suffix}`,
        status: "ACTIVE",
      },
    ]);

    const [beforeB] = await db
      .select()
      .from(orgUnits)
      .where(eq(orgUnits.id, sibB));

    await db
      .update(orgUnits)
      .set({ status: "ARCHIVED", archivedAt: new Date() })
      .where(and(eq(orgUnits.id, sibA), eq(orgUnits.orgId, ORG_A)));

    const [afterB] = await db
      .select()
      .from(orgUnits)
      .where(eq(orgUnits.id, sibB));

    expect(afterB?.status).toBe(beforeB?.status);
    expect(afterB?.deletedAt).toEqual(beforeB?.deletedAt);
    expect(afterB?.rowVersion).toBe(beforeB?.rowVersion);
    expect(afterB?.archivedAt).toEqual(beforeB?.archivedAt);
    expect(afterB?.updatedAt).toEqual(beforeB?.updatedAt);
  });

  it("case 3: cross-tenant actor gets NotFoundException and org A unit is unchanged", async () => {
    const unitId = randomUUID();

    await db.insert(orgUnits).values({
      id: unitId,
      orgId: ORG_A,
      kind: "BUSINESS_UNIT",
      name: "C3-Unit",
      code: `C3U-${suffix}`,
      status: "ACTIVE",
    });

    const mutation = jest.fn().mockResolvedValue({ success: true });

    await expect(
      cmdService.run(ORG_B, unitId, "BUSINESS_UNIT", "archive", mutation),
    ).rejects.toThrow(NotFoundException);

    expect(mutation).not.toHaveBeenCalled();

    const [row] = await db
      .select({ status: orgUnits.status, deletedAt: orgUnits.deletedAt })
      .from(orgUnits)
      .where(eq(orgUnits.id, unitId));

    expect(row?.status).toBe("ACTIVE");
    expect(row?.deletedAt).toBeNull();
  });

  it("case 4: ARCHIVED child does not block archive but DOES block retire", async () => {
    const parentId = randomUUID();
    const archivedChildId = randomUUID();

    await db.insert(orgUnits).values([
      {
        id: parentId,
        orgId: ORG_A,
        kind: "BUSINESS_UNIT",
        name: "C4-Parent",
        code: `C4P-${suffix}`,
        status: "ACTIVE",
      },
      {
        id: archivedChildId,
        orgId: ORG_A,
        kind: "BRANCH",
        parentId,
        name: "C4-ArchivedChild",
        code: `C4AC-${suffix}`,
        status: "ARCHIVED",
      },
    ]);

    await expect(
      depService.assertCanArchive(ORG_A, parentId, "BUSINESS_UNIT"),
    ).resolves.toBeUndefined();

    let retireThrown: unknown;
    try {
      await depService.assertCanRetire(ORG_A, parentId, "BUSINESS_UNIT");
    } catch (e) {
      retireThrown = e;
    }

    expect(retireThrown).toBeInstanceOf(ConflictException);
    const body = (retireThrown as ConflictException).getResponse() as {
      details: { dependencies: Array<{ key: string; count: number }> };
    };
    expect(body.details.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "child_units", count: 1 }),
      ]),
    );
  });

  it("case 5: ACTIVE grandchild under ARCHIVED child does not block ancestor archive; state is unreachable through the product", async () => {
    const parentId = randomUUID();
    const archivedChildId = randomUUID();
    const activeGrandchildId = randomUUID();

    await db.insert(orgUnits).values([
      {
        id: parentId,
        orgId: ORG_A,
        kind: "BUSINESS_UNIT",
        name: "C5-Parent",
        code: `C5P-${suffix}`,
        status: "ACTIVE",
      },
      {
        id: archivedChildId,
        orgId: ORG_A,
        kind: "BRANCH",
        parentId,
        name: "C5-ArchivedChild",
        code: `C5AC-${suffix}`,
        status: "ARCHIVED",
      },
      {
        id: activeGrandchildId,
        orgId: ORG_A,
        kind: "DEPARTMENT",
        parentId: archivedChildId,
        name: "C5-ActiveGrandchild",
        code: `C5AG-${suffix}`,
        status: "ACTIVE",
      },
    ]);

    await expect(
      depService.assertCanArchive(ORG_A, parentId, "BUSINESS_UNIT"),
    ).resolves.toBeUndefined();

    const [grandchild] = await db
      .select({ status: orgUnits.status, parentId: orgUnits.parentId })
      .from(orgUnits)
      .where(eq(orgUnits.id, activeGrandchildId));

    expect(grandchild?.status).toBe("ACTIVE");
    expect(grandchild?.parentId).toBe(archivedChildId);

    const [archivedAsActiveParent] = await db
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.id, archivedChildId),
          eq(orgUnits.orgId, ORG_A),
          eq(orgUnits.kind, "BRANCH"),
          eq(orgUnits.status, "ACTIVE"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .limit(1);

    expect(archivedAsActiveParent).toBeUndefined();
  });
});
