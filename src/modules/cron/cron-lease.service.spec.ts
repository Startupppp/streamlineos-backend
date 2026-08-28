import { CronLeaseService } from "./cron-lease.service";
import { PROCESS_CELL_ID } from "../../common/cell-resources/cell-id";

describe("CronLeaseService", () => {
  it("runs one worker and releases only its lease token", async () => {
    const redis = {
      set: jest.fn().mockResolvedValue("OK"),
      eval: jest.fn().mockResolvedValue(1),
    };
    const work = jest.fn().mockResolvedValue({ delivered: 2 });

    const result = await new CronLeaseService(redis as never).withLease("outbox-events-worker", 120, work);

    expect(result).toEqual({ ran: true, result: { delivered: 2 } });
    expect(work).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(`cron:lease:${PROCESS_CELL_ID}:outbox-events-worker`, expect.any(String), { ex: 120, nx: true });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("get", KEYS[1]) == ARGV[1]'),
      [`cron:lease:${PROCESS_CELL_ID}:outbox-events-worker`],
      [expect.any(String)],
    );
  });

  it("does not replay work while another scheduler invocation owns the lease", async () => {
    const redis = {
      set: jest.fn().mockResolvedValue(null),
      eval: jest.fn(),
    };
    const work = jest.fn();

    const result = await new CronLeaseService(redis as never).withLease("outbox-events-worker", 120, work);

    expect(result).toEqual({ ran: false });
    expect(work).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("still invokes the worker when Redis is unavailable, preserving outbox replay safety", async () => {
    const work = jest.fn().mockResolvedValue("ok");

    await expect(new CronLeaseService(null).withLease("outbox-events-worker", 120, work))
      .resolves.toEqual({ ran: true, result: "ok" });
    expect(work).toHaveBeenCalledTimes(1);
  });

  describe("genuinely concurrent exclusivity", () => {
    function buildFakeRedis(store: Map<string, string>) {
      return {
        set(key: string, value: string, opts?: { ex?: number; nx?: boolean }): Promise<"OK" | null> {
          if (opts?.nx === true && store.has(key)) {
            return Promise.resolve<"OK" | null>(null);
          }
          store.set(key, value);
          return Promise.resolve<"OK" | null>("OK");
        },
        eval(_script: string, keys: string[], argv: string[]): Promise<number> {
          const key = keys[0];
          const expectedToken = argv[0];
          if (key !== undefined && expectedToken !== undefined && store.get(key) === expectedToken) {
            store.delete(key);
            return Promise.resolve(1);
          }
          return Promise.resolve(0);
        },
      };
    }

    it("allows exactly one execution and one set of side effects when two invocations race", async () => {
      const store = new Map<string, string>();
      const service = new CronLeaseService(buildFakeRedis(store) as never);
      let sideEffects = 0;
      const fn = async () => {
        sideEffects++;
        await Promise.resolve();
        return "done";
      };

      const [r1, r2] = await Promise.all([
        service.withLease("race-job", 60, fn),
        service.withLease("race-job", 60, fn),
      ]);

      expect(sideEffects).toBe(1);
      const loser = [r1, r2].find((o) => !o.ran);
      expect(loser).toEqual({ ran: false });
    });

    it("negative control: both invocations execute when NX semantics are absent, proving the race test is not vacuous", async () => {
      const store = new Map<string, string>();
      const brokenFake = {
        set(key: string, value: string, _opts?: { ex?: number; nx?: boolean }): Promise<"OK"> {
          store.set(key, value);
          return Promise.resolve<"OK">("OK");
        },
        eval(_script: string, keys: string[], argv: string[]): Promise<number> {
          const key = keys[0];
          const expectedToken = argv[0];
          if (key !== undefined && expectedToken !== undefined && store.get(key) === expectedToken) {
            store.delete(key);
            return Promise.resolve(1);
          }
          return Promise.resolve(0);
        },
      };
      const service = new CronLeaseService(brokenFake as never);
      let sideEffects = 0;
      const fn = async () => {
        sideEffects++;
        await Promise.resolve();
        return "done";
      };

      await Promise.all([
        service.withLease("bypass-job", 60, fn),
        service.withLease("bypass-job", 60, fn),
      ]);

      expect(sideEffects).toBe(2);
    });

    it("permits re-acquisition once the prior holder's window elapses", async () => {
      const store = new Map<string, string>();
      const service = new CronLeaseService(buildFakeRedis(store) as never);

      store.set(`cron:lease:${PROCESS_CELL_ID}:expiry-job`, "stale-token");

      const whileHeld = await service.withLease("expiry-job", 1, async () => "during");
      expect(whileHeld).toEqual({ ran: false });

      store.delete(`cron:lease:${PROCESS_CELL_ID}:expiry-job`);

      const afterExpiry = await service.withLease("expiry-job", 1, async () => "after");
      expect(afterExpiry).toEqual({ ran: true, result: "after" });
    });
  });
});
