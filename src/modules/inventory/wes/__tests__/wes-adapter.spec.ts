import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import { NoopWesAdapter, notifyWes, type WesAdapter, type WesTask } from "../wes-adapter";

const TASK: WesTask = {
  taskRef: "pick:1:2",
  kind: "PICK",
  warehouseId: 1,
  productVariantId: 7,
  fromLocationCode: "A-01-1",
  toLocationCode: null,
  quantity: "3.0000",
};

describe("NEO-13 - the WES boundary", () => {
  it("says it is not live, rather than reporting a dispatch that did not happen", async () => {
    // The whole point. An adapter that returned `accepted: true` would read as a
    // working integration on a demo, and the first real deployment would find out
    // at the worst possible moment.
    const adapter = new NoopWesAdapter();
    expect(adapter.isLive).toBe(false);

    const ack = await adapter.assignTask(TASK);
    expect(ack.accepted).toBe(false);
    expect(ack.reason).toMatch(/not dispatched|No warehouse-execution system/);
    expect(ack.taskRef).toBe(TASK.taskRef);
  });

  it("never lets an adapter failure escape into the caller", async () => {
    // A picker whose confirmation was rejected because a conveyor did not answer
    // would rightly stop trusting the device, and the units have already moved.
    const angry: WesAdapter = {
      name: "angry",
      isLive: true,
      assignTask: () => Promise.reject(new Error("conveyor offline")),
      ack: () => Promise.reject(new Error("conveyor offline")),
    };

    const logger = new Logger("test");
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);

    await expect(notifyWes(angry, TASK, logger)).resolves.toBeNull();
    // Swallowed *and logged*: a failure nobody can see is how the next outage
    // becomes invisible.
    expect(warn).toHaveBeenCalled();
  });

  it("holds no robotics, no queue table and no engine import", () => {
    // "No fake robotics" is the work order's own wording, and this is what makes
    // it checkable. A WES tells machinery where to move things; the ledger records
    // what moved, and this file must not be able to reach it.
    // Comments stripped first: the prose above the class names the engine on
    // purpose, to say it must not reach it. The ratchet is about the code.
    const source = readFileSync(join(__dirname, "..", "wes-adapter.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

    expect(source).not.toMatch(/StockEngineService/);
    expect(source).not.toMatch(/drizzle-orm/);
    expect(source).not.toMatch(/fetch\(/);
  });
});
