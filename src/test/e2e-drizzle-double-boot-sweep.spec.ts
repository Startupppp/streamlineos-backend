import { withBootSweepExecute } from "../../test/helpers/e2e-app";

describe("a DRIZZLE double in the controller e2e tier", () => {
  it("gains an execute, because DrizzleModule.onApplicationBootstrap calls db.execute to assert RLS and a double without it throws TypeError before any test issues its first request", async () => {
    const prepared = withBootSweepExecute({});

    expect("execute" in prepared).toBe(true);

    const execute: unknown = Reflect.get(prepared, "execute");
    if (typeof execute !== "function") throw new Error("execute is not callable");
    await expect(execute()).resolves.toEqual([]);
  });

  it("returns an empty row set, because assertRlsIsEnforced returns early when there is no first row rather than judging the role", async () => {
    const execute: unknown = Reflect.get(withBootSweepExecute({}), "execute");
    if (typeof execute !== "function") throw new Error("execute is not callable");

    await expect(execute()).resolves.toHaveLength(0);
  });

  it("gains a __client that ends, because DrizzleModule.onApplicationShutdown drains db.__client and app.close() otherwise throws after every test has already run", async () => {
    const prepared = withBootSweepExecute({});
    const client: unknown = Reflect.get(prepared, "__client");
    if (client === null || typeof client !== "object") throw new Error("__client is not an object");

    const end: unknown = Reflect.get(client, "end");
    if (typeof end !== "function") throw new Error("end is not callable");
    await expect(end({ timeout: 1 })).resolves.toBeUndefined();
  });

  it("leaves a double that already answers execute, __client, select and transaction untouched, so a spec asserting its own rows keeps them", () => {
    const rows = [{ role_name: "streamline_app" }];
    const double = {
      execute: () => Promise.resolve(rows),
      __client: { end: () => Promise.resolve() },
      select: () => ({ from: () => Promise.resolve(rows) }),
      transaction: (work: (tx: unknown) => Promise<unknown>) => work({}),
    };

    expect(withBootSweepExecute(double)).toBe(double);
  });

  it("keeps methods a double carries on its own prototype, because the seeding check reads transaction and insert off the value it is handed", () => {
    class DoubleWithPrototypeMethods {
      transaction(): void {}
      insert(): void {}
    }
    const prepared = withBootSweepExecute(new DoubleWithPrototypeMethods());

    expect(typeof Reflect.get(prepared, "transaction")).toBe("function");
    expect(typeof Reflect.get(prepared, "insert")).toBe("function");
    expect(typeof Reflect.get(prepared, "execute")).toBe("function");
  });
});
