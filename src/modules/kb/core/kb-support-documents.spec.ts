import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { recordEngagement } from "./kb-support-documents";
import type { TenantTx } from "../../../db/drizzle.types";

function makeTx(): { tx: TenantTx; capturedSet: Record<string, unknown>[] } {
  const capturedSet: Record<string, unknown>[] = [];
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockImplementation((values: Record<string, unknown>) => {
    capturedSet.push(values);
    return { where };
  });
  const update = jest.fn().mockReturnValue({ set });
  return { tx: { update } as unknown as TenantTx, capturedSet };
}

describe("recordEngagement bumps the counter and emits no Index event", () => {
  afterEach(() => jest.restoreAllMocks());

  it("view engagement updates the views column and calls neither OutboxWriter.emit nor OutboxWriter.emitMany", async () => {
    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    const emitManySpy = jest.spyOn(OutboxWriter, "emitMany").mockResolvedValue(undefined);
    const { tx, capturedSet } = makeTx();

    await recordEngagement(tx, 42, "view");

    expect(emitSpy).not.toHaveBeenCalled();
    expect(emitManySpy).not.toHaveBeenCalled();
    expect(capturedSet).toHaveLength(1);
    expect(capturedSet[0]).toHaveProperty("views");
  });

  it("helpful engagement updates helpfulCount and emits nothing", async () => {
    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    const emitManySpy = jest.spyOn(OutboxWriter, "emitMany").mockResolvedValue(undefined);
    const { tx, capturedSet } = makeTx();

    await recordEngagement(tx, 7, "helpful");

    expect(emitSpy).not.toHaveBeenCalled();
    expect(emitManySpy).not.toHaveBeenCalled();
    expect(capturedSet).toHaveLength(1);
    expect(capturedSet[0]).toHaveProperty("helpfulCount");
    expect(capturedSet[0]).not.toHaveProperty("views");
  });

  it("not_helpful engagement updates notHelpfulCount and emits nothing", async () => {
    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    const emitManySpy = jest.spyOn(OutboxWriter, "emitMany").mockResolvedValue(undefined);
    const { tx, capturedSet } = makeTx();

    await recordEngagement(tx, 3, "not_helpful");

    expect(emitSpy).not.toHaveBeenCalled();
    expect(emitManySpy).not.toHaveBeenCalled();
    expect(capturedSet).toHaveLength(1);
    expect(capturedSet[0]).toHaveProperty("notHelpfulCount");
    expect(capturedSet[0]).not.toHaveProperty("views");
    expect(capturedSet[0]).not.toHaveProperty("helpfulCount");
  });
});
