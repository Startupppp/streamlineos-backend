jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import "reflect-metadata";
import { MailController } from "./mail.controller";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";

describe("MailController RBAC metadata", () => {
  const expectations: ReadonlyArray<[keyof MailController, string]> = [
    ["listAccounts", "mail:inbox:view"],
    ["listMessages", "mail:inbox:view"],
    ["getMessage", "mail:inbox:view"],
    ["getThread", "mail:inbox:view"],
    ["sendMail", "mail:messages:send"],
    ["replyMail", "mail:messages:send"],
    ["performAction", "mail:messages:manage"],
    ["getAttachment", "mail:inbox:view"],
  ];

  it.each(expectations)("%s requires %s", (method, permission) => {
    const handler = MailController.prototype[method];
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBe(permission);
  });
});
