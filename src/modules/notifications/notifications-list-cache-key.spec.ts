/**
 * `GET /notifications?sourceModule=hr` and `?sourceModule=chat` used to share a
 * cache entry.
 *
 * The key was written out by hand —
 * `list:${section}:${category}:${priority}:${limit}:${cursor}:${search}` — and
 * `sourceModule` was missing from it while being an accepted, `.strict()`-validated
 * query parameter and a real SQL predicate. Two different filters therefore hashed
 * to the same string under `notifications:<user>:<org>`, and for the 30 s of
 * `CACHE_TTL.SHORT` the second caller was served the first one's filtered page.
 * Scoped to one user in one org, so not a tenant leak — just silently wrong data,
 * in a place no gate looks: `check:namespace-coverage` verifies that namespaces are
 * BUMPED, never that a key enumerates every dimension that changes the result.
 *
 * The assertion below is the general form, not a patch for one field: every field
 * `listSchema` accepts must reach the key. A filter added later fails this without
 * anyone remembering why.
 */
import { DRIZZLE } from "../../db/drizzle.constants";
import { Test } from "@nestjs/testing";
import { CacheService } from "../../common/cache/cache.service";
import { NotificationsReadService } from "./notifications-read.service";
import { NotificationVisibilityRegistry } from "./notification-visibility.registry";
import { listSchema, type ListInput } from "./dto/notification.schemas";

describe("notifications list cache key", () => {
  const keys: string[] = [];
  let service: NotificationsReadService;

  const cache = {
    cachedVersioned: jest.fn((_namespace: string, key: string) => {
      keys.push(key);
      return Promise.resolve({ data: [], hasMore: false, nextCursor: null });
    }),
  };

  beforeEach(async () => {
    keys.length = 0;
    cache.cachedVersioned.mockClear();
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsReadService,
        NotificationVisibilityRegistry,
        { provide: DRIZZLE, useValue: {} },
        { provide: CacheService, useValue: cache },
      ],
    }).compile();
    service = moduleRef.get(NotificationsReadService);
  });

  function filters(over: Partial<ListInput> = {}): ListInput {
    return listSchema.parse({ ...over });
  }

  it("two different sourceModule filters do not share an entry", async () => {
    await service.list("org-1", "user-1", filters({ sourceModule: "hr" }));
    await service.list("org-1", "user-1", filters({ sourceModule: "chat" }));

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("the same filter still shares an entry — the cache is not simply defeated", async () => {
    await service.list("org-1", "user-1", filters({ sourceModule: "hr" }));
    await service.list("org-1", "user-1", filters({ sourceModule: "hr" }));

    expect(keys[0]).toBe(keys[1]);
  });

  it("every field listSchema accepts reaches the key", async () => {
    const baseline = filters();
    await service.list("org-1", "user-1", baseline);
    const control = keys[0];

    // One field at a time: a key that does not move when a filter moves is a key
    // that would serve the wrong page for it.
    const probes: Array<[string, Partial<ListInput>]> = [
      ["section", { section: "MENTIONS" }],
      ["category", { category: "HRMS" }],
      ["priority", { priority: "HIGH" }],
      ["sourceModule", { sourceModule: "hr" }],
      ["search", { search: "invoice" }],
      ["limit", { limit: 50 }],
      ["cursor", { cursor: 4242 }],
      ["unreadOnly", { unreadOnly: true }],
    ];
    expect(probes.map(([field]) => field).sort()).toEqual(Object.keys(listSchema.shape).sort());

    for (const [field, over] of probes) {
      keys.length = 0;
      await service.list("org-1", "user-1", { ...baseline, ...over });
      expect([field, keys[0]]).not.toEqual([field, control]);
    }
  });

  it("separator characters in search and source cannot collide with filter structure", async () => {
    await service.list("org-1", "user-1", filters({
      search: "x", sourceModule: "y&section=ALL&sourceModule=z",
    }));
    await service.list("org-1", "user-1", filters({
      search: "x&section=ALL&sourceModule=y", sourceModule: "z",
    }));
    expect(keys[0]).not.toBe(keys[1]);
  });
});
