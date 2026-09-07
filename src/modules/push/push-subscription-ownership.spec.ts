import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { pushSubscriptions } from "../../db/schema";
import {
  PUSH_ENDPOINT_CONFLICT,
  pushSubscriptionOwnership,
} from "./push-subscription-ownership";

describe("push subscription ownership — hermetic", () => {
  it("the unique it arbitrates is declared TOTAL, which is what makes a bare target legal", () => {
    const endpoint = getTableConfig(pushSubscriptions).columns.find((c) => c.name === "endpoint");
    expect(endpoint?.isUnique).toBe(true);
    expect(
      getTableConfig(pushSubscriptions).indexes.some((index) =>
        (index as unknown as { config: { columns: Array<{ name?: string }>; where?: unknown } }).config.columns.some(
          (column) => column.name === "endpoint",
        ),
      ),
    ).toBe(false);
    expect(Object.keys(PUSH_ENDPOINT_CONFLICT)).toEqual(["target"]);
  });

  it("the upsert re-owns user_id, org_id and membership_id — the head form re-owned neither", () => {
    const offline = drizzle(postgres("postgres://unused@127.0.0.1:1/unused", { max: 1 }));
    const values = {
      userId: "u2",
      orgId: "org-b",
      endpoint: "https://fcm.example/e",
      p256dh: "p2",
      auth: "a2",
    };
    const compile = (set: Record<string, unknown>) =>
      offline
        .insert(pushSubscriptions)
        .values(values)
        .onConflictDoUpdate({
          ...PUSH_ENDPOINT_CONFLICT,
          set,
        })
        .toSQL().sql;

    const head = compile({ p256dh: values.p256dh, auth: values.auth });
    const shipped = compile(pushSubscriptionOwnership(values));

    expect(head).not.toContain('"user_id" =');
    expect(head).not.toContain('"org_id" =');
    expect(shipped).toContain('on conflict ("endpoint") do update set');
    expect(shipped).toContain('"user_id" =');
    expect(shipped).toContain('"org_id" =');
    expect(shipped).toContain('"membership_id" =');
  });

  it("re-ownership nulls membership_id, because (org_id, membership_id) is a composite FK", () => {
    expect(pushSubscriptionOwnership({ userId: "u", orgId: "o", p256dh: "p", auth: "a" })).toEqual({
      userId: "u",
      orgId: "o",
      membershipId: null,
      p256dh: "p",
      auth: "a",
      userAgent: null,
    });
  });
});
