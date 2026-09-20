import { logger } from "../logger/logger.service";
import {
  resetErrorReporter,
  setErrorReporter,
  type ErrorReport,
  type ErrorReporter,
} from "./error-reporter";
import {
  describeFailure,
  installProcessFailureHandlers,
  resetFatalHandler,
  setFatalHandler,
} from "./process-failure";

type Listener = (value: unknown) => void;

function fakeProcess() {
  const listeners = new Map<string, Listener[]>();
  return {
    on(event: string, listener: Listener) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return this;
    },
    emit(event: string, value: unknown): void {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    countFor(event: string): number {
      return (listeners.get(event) ?? []).length;
    },
  };
}

describe("process failure handlers", () => {
  let reports: ErrorReport[];
  let errorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    reports = [];
    const capturing: ErrorReporter = { report: (report) => reports.push(report) };
    setErrorReporter(capturing);
    errorSpy = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
  });

  afterEach(() => {
    resetFatalHandler();
    resetErrorReporter();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("stops serving on an uncaught exception, because the process state is no longer trustworthy and a survivor leaks whatever the throw abandoned", () => {
    const target = fakeProcess();
    const fatal = jest.fn();
    setFatalHandler(fatal);
    installProcessFailureHandlers(target);

    target.emit("uncaughtException", new Error("wake() threw inside setInterval"));

    expect(fatal).toHaveBeenCalledTimes(1);
  });

  it("runs the fatal handler once, so a second throw during shutdown cannot re-enter the drain", () => {
    const target = fakeProcess();
    const fatal = jest.fn();
    setFatalHandler(fatal);
    installProcessFailureHandlers(target);

    target.emit("uncaughtException", new Error("first"));
    target.emit("uncaughtException", new Error("second"));

    expect(fatal).toHaveBeenCalledTimes(1);
  });

  it("reports an uncaught exception so a timer crash is classified like a request failure", () => {
    const target = fakeProcess();
    installProcessFailureHandlers(target);
    const thrown = new Error("boom");

    target.emit("uncaughtException", thrown);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.error).toBe(thrown);
    expect(reports[0]?.extra).toMatchObject({ source: "uncaughtException" });
  });

  it("logs the stack of an uncaught exception rather than only its message", () => {
    const target = fakeProcess();
    installProcessFailureHandlers(target);
    const thrown = new Error("boom");

    target.emit("uncaughtException", thrown);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const meta = errorSpy.mock.calls[0]?.[1] as { error?: string };
    expect(meta.error).toContain("boom");
    expect(meta.error).toContain("process-failure.spec.ts");
  });

  it("still reports unhandled rejections once the uncaught handler is installed", () => {
    const target = fakeProcess();
    installProcessFailureHandlers(target);

    target.emit("unhandledRejection", new Error("dropped void promise"));

    expect(reports).toHaveLength(1);
    expect(reports[0]?.extra).toMatchObject({ source: "unhandledRejection" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("registers one listener per failure kind so a second install cannot double-report", () => {
    const target = fakeProcess();

    installProcessFailureHandlers(target);
    installProcessFailureHandlers(target);

    expect(target.countFor("uncaughtException")).toBe(1);
    expect(target.countFor("unhandledRejection")).toBe(1);
  });

  it("survives a reporter that throws while reporting an uncaught exception", () => {
    setErrorReporter({
      report: () => {
        throw new Error("tracker unavailable");
      },
    });
    const target = fakeProcess();
    installProcessFailureHandlers(target);

    expect(() => target.emit("uncaughtException", new Error("boom"))).not.toThrow();
  });

  it("describes a non-Error rejection reason without throwing on it", () => {
    expect(describeFailure("plain string")).toBe("plain string");
    expect(describeFailure({ code: 42 })).toContain("object");
    expect(describeFailure(new Error("with stack"))).toContain("with stack");
  });
});
