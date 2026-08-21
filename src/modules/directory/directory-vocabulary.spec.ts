import "reflect-metadata";
import { NotificationsController } from "../notifications/notifications.controller";
import { NotificationPreferencesController } from "../notifications/notification-preferences.controller";
import { DirectoryController } from "./directory.controller";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import { ROLE_DEFAULT_PERMISSIONS } from "../rbac/permissions";

describe("Notification self-service routes: no permission gate", () => {
  const selfServiceHandlers: ReadonlyArray<keyof NotificationsController> = [
    "list",
    "unreadCount",
    "generateStreamToken",
    "stream",
    "markAllRead",
    "clearAll",
    "bulkMarkRead",
    "bulkArchive",
    "bulkDelete",
    "markRead",
    "archive",
    "unarchive",
    "softDelete",
    "pin",
    "unpin",
    "snooze",
    "approve",
    "reject",
  ];

  it.each(selfServiceHandlers)("NotificationsController#%s carries no @RequirePermission", (method) => {
    const handler = NotificationsController.prototype[method];
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBeUndefined();
  });

  const preferenceHandlers: ReadonlyArray<keyof NotificationPreferencesController> = [
    "get",
    "update",
    "listRules",
    "setRule",
    "eventCatalog",
    "updateEvent",
    "reset",
    "listSuppressions",
    "createSuppression",
    "removeSuppression",
  ];

  it.each(preferenceHandlers)("NotificationPreferencesController#%s carries no @RequirePermission", (method) => {
    const handler = NotificationPreferencesController.prototype[method];
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBeUndefined();
  });
});

describe("Reading the people directory is universal", () => {
  const readHandlers: ReadonlyArray<keyof DirectoryController> = [
    "listPeople",
    "getPerson",
  ];

  it.each(readHandlers)("DirectoryController#%s carries no @RequirePermission", (method) => {
    const handler = DirectoryController.prototype[method];
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBeUndefined();
  });
});

describe("Directory people mutations: correct gates", () => {
  const expectations: ReadonlyArray<[keyof DirectoryController, string]> = [
    ["createPerson", "directory:people:create"],
    ["updatePerson", "directory:people:update"],
    ["deletePerson", "directory:people:delete"],
  ];

  it.each(expectations)("DirectoryController#%s requires %s", (method, key) => {
    const handler = DirectoryController.prototype[method];
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBe(key);
  });
});

describe("Directory worker routes: correct gates", () => {
  const expectations: ReadonlyArray<[keyof DirectoryController, string]> = [
    ["listWorkers", "workforce:workers:view"],
    ["getWorker", "workforce:workers:view"],
    ["listEngagements", "workforce:workers:view"],
    ["createWorker", "workforce:workers:manage"],
    ["createEngagement", "workforce:workers:manage"],
    ["updateEngagement", "workforce:workers:manage"],
    ["cancelEngagement", "workforce:workers:manage"],
    ["terminateEngagement", "workforce:workers:terminate"],
  ];

  it.each(expectations)("DirectoryController#%s requires %s", (method, key) => {
    const handler = DirectoryController.prototype[method];
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBe(key);
  });
});

describe("Member role defaults: universal access", () => {
  it("MEMBER still holds directory:people:view, which gates the org people list elsewhere", () => {
    expect(ROLE_DEFAULT_PERMISSIONS["MEMBER"]).toContain("directory:people:view");
  });
});
