import "reflect-metadata";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { IDEMPOTENCY_COMMAND } from "../../common/idempotency/idempotency.constants";
import { ChatActionsController } from "./chat-actions.controller";
import { ChatEntityActionsController } from "./chat-entity-actions.controller";
import { ChatHuddlesController } from "./chat-huddles.controller";
import { ChatSummarizeController } from "./chat-summarize.controller";

/**
 * `pnpm check:idempotent-commands` is green over the whole chat module and is VACUOUS there.
 *
 * Its corpus is a keyword list (`checkout|purchase|payout|…|invite|submit|…`) matched against
 * the full route path, and `chat/actions/create-task-from-message` contains none of those
 * words — so the gate reported "0 unfenced" over a handler that files a real ticket in the
 * Build module and would file a second one on every retry. Measured: widening that keyword
 * list with `create-[a-z-]+` moves the gate from 130 critical handlers / 0 unfenced to 135 /
 * 4, and the four newly-visible unfenced handlers are in e-sign, HR recruitment and
 * timesheets — other modules' files. So the fence is pinned HERE, handler by handler, rather
 * than by turning a shared gate red over code this module does not own.
 *
 * A gate that cannot see a route is not evidence about that route.
 */

const CHAT_DIR = __dirname;

function commandOf(handler: unknown): string | undefined {
  return Reflect.getMetadata(IDEMPOTENCY_COMMAND, handler as object) as
    | string
    | undefined;
}

/**
 * Every chat controller handler that submits a write into ANOTHER module.
 *
 * Derived from source, not listed: `EntityReferenceService.submitAction` is the one seam
 * chat uses to create or transition a record it does not own (a Build ticket, a CRM deal
 * stage), and nothing on the far side of that seam is keyed on anything the chat request
 * carries — a retry files a second ticket. A fourth such handler added later appears here
 * automatically and fails the subset assertion below if it is unfenced.
 */
function crossModuleWriteHandlers(): { file: string; method: string }[] {
  const found: { file: string; method: string }[] = [];
  for (const file of readdirSync(CHAT_DIR)) {
    if (!file.endsWith(".controller.ts")) continue;
    const lines = readFileSync(join(CHAT_DIR, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("this.entities.submitAction(")) return;
      for (let back = index; back >= 0; back--) {
        const signature = /^\s{2}(?:async\s+)?(\w+)\s*\(/.exec(lines[back] ?? "");
        if (signature?.[1] !== undefined) {
          found.push({ file, method: signature[1] });
          return;
        }
      }
    });
  }
  return found;
}

/** Measured at 299cd1009: chat-actions.createTaskFromMessage and chat-entity-actions.submitAction. */
const MEASURED_CROSS_MODULE_WRITE_FLOOR = 2;

const FENCED: ReadonlyArray<[string, string, string, unknown, string]> = [
  [
    "POST /chat/actions/create-task-from-message",
    "chat-actions.controller.ts",
    "createTaskFromMessage",
    ChatActionsController.prototype.createTaskFromMessage,
    "chat.action.create-task-from-message",
  ],
  [
    "POST /chat/entity-actions/submit",
    "chat-entity-actions.controller.ts",
    "submitAction",
    ChatEntityActionsController.prototype.submitAction,
    "chat.action.submit",
  ],
  [
    "POST /chat/huddles/:huddleId/invite",
    "chat-huddles.controller.ts",
    "invite",
    ChatHuddlesController.prototype.invite,
    "chat.huddle.invite",
  ],
  [
    "POST /chat/channels/:channelId/summarize",
    "chat-summarize.controller.ts",
    "summarize",
    ChatSummarizeController.prototype.summarize,
    "chat.summarize",
  ],
];

/**
 * Every `@Idempotent` handler the chat module declares, read from source.
 *
 * This is the corpus that makes the table above honest: a fenced route that nobody added
 * here would otherwise be pinned by nothing, and its frontend caller would keep 400ing with
 * no test able to see it. The frontend half derives the same list from the same files
 * (streamlineos-frontend/frontend/hooks/api/chat-idempotency.test.tsx).
 */
function declaredFencedHandlers(): { file: string; method: string }[] {
  const found: { file: string; method: string }[] = [];
  for (const file of readdirSync(CHAT_DIR)) {
    if (!file.endsWith(".controller.ts")) continue;
    const lines = readFileSync(join(CHAT_DIR, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!/^\s*@Idempotent\b/.test(line)) return;
      for (let forward = index; forward < lines.length; forward++) {
        const signature = /^\s{2}(?:async\s+)?(\w+)\s*\(/.exec(lines[forward] ?? "");
        if (signature?.[1] !== undefined) {
          found.push({ file, method: signature[1] });
          return;
        }
      }
    });
  }
  return found;
}

describe("chat command fencing", () => {
  describe.each(FENCED)("%s", (_route, _file, _method, handler, command) => {
    it(`is fenced as "${command}"`, () => {
      expect(commandOf(handler)).toBe(command);
    });
  });

  it("finds the cross-module write handlers in source", () => {
    // Anti-vacuity: a scanner that stopped matching would derive an empty corpus,
    // and the subset assertion below would pass over nothing at all.
    const handlers = crossModuleWriteHandlers();
    expect(handlers.length).toBeGreaterThanOrEqual(
      MEASURED_CROSS_MODULE_WRITE_FLOOR,
    );
  });

  it("fences every handler that writes into another module through the entity seam", () => {
    // The check is on the handler's OWN metadata, not on membership of the table
    // above: a table entry proves only that someone typed the route out once.
    const known = new Map(
      FENCED.map(([, file, method, handler]) => [`${file}::${method}`, handler]),
    );
    const unfenced = crossModuleWriteHandlers()
      .map(({ file, method }) => `${file}::${method}`)
      .filter((id) => {
        const handler = known.get(id);
        return handler === undefined || commandOf(handler) === undefined;
      });
    expect(unfenced).toEqual([]);
  });

  /**
   * The fence is only half the contract: `IdempotencyInterceptor` 400s a fenced route that
   * arrives with no `Idempotency-Key`, so a caller that does not send one turns the fence
   * into an outage. The frontend half is pinned in
   * streamlineos-frontend/frontend/hooks/api/chat-idempotency.test.tsx, which derives this
   * same route list from these same controllers.
   */
  it("keeps every fenced command name namespaced to chat", () => {
    for (const [, , , handler] of FENCED)
      expect(commandOf(handler)).toMatch(/^chat\./);
  });

  it("pins every @Idempotent handler the chat module declares", () => {
    const declared = declaredFencedHandlers().map(
      ({ file, method }) => `${file}::${method}`,
    );
    // Anti-vacuity: an empty read would make the comparison below trivially true.
    expect(declared.length).toBeGreaterThanOrEqual(FENCED.length);
    expect(declared.sort()).toEqual(
      FENCED.map(([, file, method]) => `${file}::${method}`).sort(),
    );
  });
});
