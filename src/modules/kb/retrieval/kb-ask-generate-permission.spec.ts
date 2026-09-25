import { Reflector } from "@nestjs/core";
import { REQUIRE_PERMISSION } from "../../access/require-permission.decorator";
import { KbAskController } from "./kb-ask.controller";

describe("KbAskController — spending AI credit is its own permission", () => {
  const reflector = new Reflector();
  const keyOf = (handler: keyof KbAskController) =>
    reflector.get<string | undefined>(
      REQUIRE_PERMISSION,
      KbAskController.prototype[handler] as never,
    );

  it("gates answer generation on kb:ai:generate, so the ability to spend credit is not inferred from the ability to read a page", () => {
    expect(keyOf("askQuestion")).toBe("kb:ai:generate");
    expect(keyOf("askStream")).toBe("kb:ai:generate");
  });

  it("leaves the non-generating history routes on kb:pages:view, so the new key is a real distinction and not a blanket rename", () => {
    expect(keyOf("getHistory")).toBe("kb:pages:view");
    expect(keyOf("clearHistory")).toBe("kb:pages:view");
  });

  it("gates create-knowledge-gap on kb:pages:view, the same standing the sibling feedback action requires — not on kb:ai:generate, since flagging a gap spends no AI credit", () => {
    expect(keyOf("createKnowledgeGap")).toBe("kb:pages:view");
  });
});
