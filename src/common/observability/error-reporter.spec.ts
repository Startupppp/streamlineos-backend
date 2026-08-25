import { runWithObservabilityContext } from "./observability-context";
import {
  getErrorReporter,
  reportError,
  resetErrorReporter,
  setErrorReporter,
  type ErrorReport,
} from "./error-reporter";

describe("error reporter", () => {
  afterEach(() => resetErrorReporter());

  it("defaults to a reporter that swallows the report rather than crashing", () => {
    expect(() => reportError(new Error("boom"))).not.toThrow();
    expect(getErrorReporter()).toBeDefined();
  });

  it("forwards the error to the installed reporter", () => {
    const reports: ErrorReport[] = [];
    setErrorReporter({ report: (r) => reports.push(r) });

    const error = new Error("boom");
    reportError(error);

    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBe(error);
  });

  it("attaches the ambient organisation, actor and correlation identity", async () => {
    const reports: ErrorReport[] = [];
    setErrorReporter({ report: (r) => reports.push(r) });

    await runWithObservabilityContext(
      { correlationId: "c-1", orgId: "org-1", actorId: "user-1" },
      async () => reportError(new Error("boom")),
    );

    expect(reports[0].context).toEqual({
      correlationId: "c-1",
      orgId: "org-1",
      actorId: "user-1",
    });
  });

  it("passes redacted extra detail, never raw credentials", () => {
    const reports: ErrorReport[] = [];
    setErrorReporter({ report: (r) => reports.push(r) });

    reportError(new Error("boom"), { route: "/x", password: "hunter2" });

    expect(reports[0].extra).toEqual({ route: "/x", password: "[redacted]" });
  });

  it("never lets a failing reporter break the caller", () => {
    setErrorReporter({
      report: () => {
        throw new Error("reporter is down");
      },
    });

    expect(() => reportError(new Error("boom"))).not.toThrow();
  });
});
