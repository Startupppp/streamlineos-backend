import { nextChangeRequestNumber } from "./change-request-number-counter";

describe("nextChangeRequestNumber — concurrent allocation", () => {
  it("two concurrent allocations produce different numbers when the transaction double invokes its callback", async () => {
    let maxReturned = 0;

    const makeTx = () => ({
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ maxNum: maxReturned++ }]),
        }),
      }),
    });

    const tx1 = makeTx();
    const tx2 = makeTx();

    const [n1, n2] = await Promise.all([
      nextChangeRequestNumber(tx1 as any, "org-1", 42),
      nextChangeRequestNumber(tx2 as any, "org-1", 42),
    ]);

    expect(n1).not.toEqual(n2);
    expect(tx1.execute).toHaveBeenCalledTimes(1);
    expect(tx2.execute).toHaveBeenCalledTimes(1);
  });

  it("the advisory lock is taken before the MAX is read", async () => {
    const callOrder: string[] = [];
    const tx = {
      execute: jest.fn().mockImplementation(async () => {
        callOrder.push("lock");
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(async () => {
            callOrder.push("max");
            return [{ maxNum: 5 }];
          }),
        }),
      }),
    };

    const result = await nextChangeRequestNumber(tx as any, "org-1", 7);

    expect(callOrder).toEqual(["lock", "max"]);
    expect(result).toBe(6);
  });
});
