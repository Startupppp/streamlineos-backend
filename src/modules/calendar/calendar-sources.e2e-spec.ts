import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { CalendarSourcePreferencesService } from "./calendar-source-preferences.service";

type PreferenceStore = Map<string, Set<string>>;

function preferenceKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

function makePreferenceStore(store: PreferenceStore) {
  return {
    getDisabledKeys: async (orgId: string, userId: string): Promise<Set<string>> =>
      new Set(store.get(preferenceKey(orgId, userId)) ?? []),
    setPreference: async (
      orgId: string,
      userId: string,
      sourceKey: string,
      enabled: boolean,
    ): Promise<void> => {
      const key = preferenceKey(orgId, userId);
      const disabled = new Set(store.get(key) ?? []);
      if (enabled) disabled.delete(sourceKey);
      else disabled.add(sourceKey);
      store.set(key, disabled);
    },
  };
}

describe("Calendar source production graph (e2e)", () => {
  let app: INestApplication;
  const preferences: PreferenceStore = new Map();

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        {
          provide: CalendarSourcePreferencesService,
          useValue: makePreferenceStore(preferences),
        },
      ],
    });
  });

  afterAll(async () => app.close());

  async function token(
    sub: string,
    orgId: string,
    enabledModules: string[] = ["hr"],
  ): Promise<string> {
    return signToken({ sub, orgId, enabledModules });
  }

  async function listSources(auth: string) {
    return request(app.getHttpServer())
      .get("/calendar/sources")
      .set("Authorization", `Bearer ${auth}`);
  }

  it("registers the production calendar sources through the real module graph", async () => {
    const auth = await token("calendar-owner", "calendar-org-registration");

    const response = await listSources(auth);

    expect(response.status).toBe(200);
    // Exhaustive on purpose: a source that registers itself and is never named here is a
    // toggle the unified calendar shows without anyone having decided it should.
    expect(response.body.map((source: { key: string }) => source.key).sort()).toEqual([
      "calendar-events",
      "hr-attendance",
      "hr-holidays",
      "hr-interviews",
      "hr-leaves",
      "tasks",
    ]);
    expect(
      response.body
        .map((source: { key: string; module: string }) => `${source.key}:${source.module}`)
        .sort(),
    ).toEqual([
      "calendar-events:calendar",
      "hr-attendance:hr",
      "hr-holidays:hr",
      "hr-interviews:hr",
      "hr-leaves:hr",
      "tasks:tasks",
    ]);
  });

  it("persists source preferences per user and organization", async () => {
    const orgAUserA = await token("calendar-user-a", "calendar-org-a");
    const orgAUserB = await token("calendar-user-b", "calendar-org-a");
    const orgBUserA = await token("calendar-user-a", "calendar-org-b");

    const update = await request(app.getHttpServer())
      .put("/calendar/sources/hr-leaves")
      .set("Authorization", `Bearer ${orgAUserA}`)
      .send({ enabled: false });

    expect(update.status).toBe(200);
    expect(update.body).toEqual({ sourceKey: "hr-leaves", enabled: false });

    const [sameUser, otherUser, otherOrg] = await Promise.all([
      listSources(orgAUserA),
      listSources(orgAUserB),
      listSources(orgBUserA),
    ]);

    expect(sameUser.body.find((source: { key: string }) => source.key === "hr-leaves")).toMatchObject({
      key: "hr-leaves",
      enabled: false,
    });
    expect(otherUser.body.find((source: { key: string }) => source.key === "hr-leaves")).toMatchObject({
      key: "hr-leaves",
      enabled: true,
    });
    expect(otherOrg.body.find((source: { key: string }) => source.key === "hr-leaves")).toMatchObject({
      key: "hr-leaves",
      enabled: true,
    });
  });

  /**
   * The assertion is exhaustive, not merely "no hr-* key": `resolveAvailable` is the only
   * thing standing between a registered source and the toggle list, and a set-difference
   * assertion would keep passing if it started letting a THIRD module's source through.
   * `calendar` and `tasks` survive because `isCoreModuleKey` reports them core — calendar
   * is registered `planGated: false`, and `tasks` has no registry entry at all — so those
   * two are the whole of what an org with no enabled modules may see.
   */
  it("does not expose registered HR sources when the HR module is unavailable", async () => {
    const auth = await token("calendar-no-hr", "calendar-org-no-hr", []);

    const response = await listSources(auth);

    expect(response.status).toBe(200);
    expect(response.body.map((source: { key: string }) => source.key).sort()).toEqual([
      "calendar-events",
      "tasks",
    ]);
    expect(
      response.body.filter((source: { module: string }) => source.module === "hr"),
    ).toEqual([]);
  });
});
