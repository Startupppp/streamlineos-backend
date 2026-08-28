import type { INestApplication } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import {
  RegionRegistry,
  setRegionRegistry,
  clearRegionRegistry,
} from "src/common/region/region-registry";
import type { OrgRegionLookup } from "src/common/region/region-registry";
import {
  LEGACY_CELL_ID,
  DEFAULT_DATABASE_SHARD,
  DEFAULT_SEARCH_CLUSTER,
  type OrganizationPlacement,
} from "src/common/region/placement";
import type { RegionDefinition } from "src/common/region/region.config";
import type { Db } from "src/db/drizzle.types";
import { DRIZZLE } from "src/db/drizzle.constants";
import { OrganizationService } from "./organization.service";

const SWITCH_TARGET = "placement-spec-org-1";

function makePlacement(
  orgId: string,
  status: OrganizationPlacement["status"],
): OrganizationPlacement {
  return {
    organizationId: orgId,
    region: "primary",
    cellId: LEGACY_CELL_ID,
    databaseShard: DEFAULT_DATABASE_SHARD,
    objectStorageRegion: "auto",
    searchCluster: DEFAULT_SEARCH_CLUSTER,
    placementVersion: 1,
    writeFenceToken: null,
    leaseExpiresAt: null,
    status,
  };
}

function buildRegistry(db: Db, lookup: OrgRegionLookup): RegionRegistry {
  const definition: RegionDefinition = {
    key: "primary",
    databaseUrl: process.env.DATABASE_URL ?? "",
    cell: {
      cellId: LEGACY_CELL_ID,
      databaseShard: DEFAULT_DATABASE_SHARD,
      searchCluster: DEFAULT_SEARCH_CLUSTER,
    },
    storage: { region: "auto", bucket: "fixture" },
  };
  return new RegionRegistry(
    { primary: "primary", regions: { primary: definition } },
    new Map([["primary", { definition, db }]]),
    lookup,
  );
}

describe("POST /organization/switch — placement states (e2e)", () => {
  let app: INestApplication;
  let db: Db;

  beforeAll(async () => {
    app = await createE2eApp({
    });
    db = app.get<Db>(DRIZZLE);
  });

  afterAll(async () => app.close());
  afterEach(() => clearRegionRegistry());

  it("503 + PLACEMENT_RELOCATING + retryable when target org is MOVING", async () => {
    const placement = makePlacement(SWITCH_TARGET, "MOVING");
    setRegionRegistry(
      buildRegistry(db, async (orgId) => (orgId === SWITCH_TARGET ? placement : null)),
    );
    const token = await signToken();
    const res = await request(app.getHttpServer())
      .post("/organization/switch")
      .set("Authorization", `Bearer ${token}`)
      .send({ orgId: SWITCH_TARGET });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: "PLACEMENT_RELOCATING",
      details: { retryable: true },
    });
  });

  it("409 + PLACEMENT_READ_ONLY + non-retryable when target org is READ_ONLY", async () => {
    const placement = makePlacement(SWITCH_TARGET, "READ_ONLY");
    setRegionRegistry(
      buildRegistry(db, async (orgId) => (orgId === SWITCH_TARGET ? placement : null)),
    );
    const token = await signToken();
    const res = await request(app.getHttpServer())
      .post("/organization/switch")
      .set("Authorization", `Bearer ${token}`)
      .send({ orgId: SWITCH_TARGET });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "PLACEMENT_READ_ONLY",
      details: { retryable: false },
    });
  });

  it("404 when target org is unplaced, response body does not expose [region]", async () => {
    setRegionRegistry(buildRegistry(db, async (_orgId) => null));
    const token = await signToken();
    const res = await request(app.getHttpServer())
      .post("/organization/switch")
      .set("Authorization", `Bearer ${token}`)
      .send({ orgId: SWITCH_TARGET });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("[region]");
  });
});

describe("Organization controller — auth and isolation (e2e)", () => {
  let app: INestApplication;
  const switchOrgFn = jest.fn();
  const listUserOrganizationsFn = jest.fn();

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        {
          provide: OrganizationService,
          useValue: {
            switchOrg: switchOrgFn,
            listUserOrganizations: listUserOrganizationsFn,
          },
        },
      ],
    });
  });

  afterAll(async () => app.close());
  afterEach(() => {
    switchOrgFn.mockReset();
    listUserOrganizationsFn.mockReset();
    clearRegionRegistry();
  });

  it("401 on POST /organization/switch without a token", async () => {
    const res = await request(app.getHttpServer())
      .post("/organization/switch")
      .send({ orgId: "some-org" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("401 on GET /organization without a token", async () => {
    const res = await request(app.getHttpServer()).get("/organization");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("200 when an authenticated member switches to their org", async () => {
    switchOrgFn.mockResolvedValueOnce({
      orgId: "org-target",
      name: "Target Org",
      slug: "target-org",
      role: "MEMBER",
    });
    const token = await signToken();
    const res = await request(app.getHttpServer())
      .post("/organization/switch")
      .set("Authorization", `Bearer ${token}`)
      .send({ orgId: "org-target" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orgId: "org-target" });
  });

  it("400 when the caller is not a member of the target org (cross-tenant isolation)", async () => {
    switchOrgFn.mockRejectedValueOnce(
      new BadRequestException("You are not a member of this organization"),
    );
    const token = await signToken();
    const res = await request(app.getHttpServer())
      .post("/organization/switch")
      .set("Authorization", `Bearer ${token}`)
      .send({ orgId: "foreign-org" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("GET /organization returns only the calling user's organizations, not another account's", async () => {
    listUserOrganizationsFn.mockImplementation(async (userId: string) => {
      if (userId === "user_alice")
        return [{ id: "org_alice", name: "Alice Org", slug: "alice-org", role: "OWNER" }];
      if (userId === "user_bob")
        return [{ id: "org_bob", name: "Bob Org", slug: "bob-org", role: "MEMBER" }];
      return [];
    });

    const [aliceToken, bobToken] = await Promise.all([
      signToken({ sub: "user_alice" }),
      signToken({ sub: "user_bob" }),
    ]);

    const [aliceRes, bobRes] = await Promise.all([
      request(app.getHttpServer())
        .get("/organization")
        .set("Authorization", `Bearer ${aliceToken}`),
      request(app.getHttpServer())
        .get("/organization")
        .set("Authorization", `Bearer ${bobToken}`),
    ]);

    expect(aliceRes.status).toBe(200);
    expect(bobRes.status).toBe(200);

    const aliceOrgs: Array<{ id: string }> = aliceRes.body;
    const bobOrgs: Array<{ id: string }> = bobRes.body;

    expect(aliceOrgs.some((o) => o.id === "org_alice")).toBe(true);
    expect(aliceOrgs.some((o) => o.id === "org_bob")).toBe(false);
    expect(bobOrgs.some((o) => o.id === "org_bob")).toBe(true);
    expect(bobOrgs.some((o) => o.id === "org_alice")).toBe(false);
  });
});
