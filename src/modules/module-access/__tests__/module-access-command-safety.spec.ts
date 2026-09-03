import { IDEMPOTENCY_COMMAND } from "../../../common/idempotency/idempotency.constants";
import { ModuleAccessController } from "../module-access.controller";

describe("module-access replayable commands are fenced", () => {
  it.each([
    {
      name: "group create",
      handler: ModuleAccessController.prototype.createGroup,
      command: "module-access.group.create",
    },
    {
      name: "ownership transfer initiate",
      handler: ModuleAccessController.prototype.initiateOwnershipTransfer,
      command: "ownership.module-access.transfer-initiate",
    },
    {
      name: "ownership transfer cancel",
      handler: ModuleAccessController.prototype.cancelOwnershipTransfer,
      command: "ownership.module-access.transfer-cancel",
    },
  ])("$name carries an idempotency command", ({ handler, command }) => {
    expect(Reflect.getMetadata(IDEMPOTENCY_COMMAND, handler)).toBe(command);
  });
});
