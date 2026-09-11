import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  type ArgumentsHost,
} from "@nestjs/common";
import { AllExceptionsFilter } from "./all-exceptions.filter";
import { resetErrorReporter, setErrorReporter } from "../observability/error-reporter";
import type { ErrorReport } from "../observability/error-reporter";

/**
 * The line between "the application said no" and "the application broke".
 *
 * A 404 on a row someone cannot see is the authorization model working; paging
 * on it teaches an operator to ignore the stream. A deliberately raised 5xx is
 * the opposite, and used to leave the `HttpException` branch with no log line
 * and no report at all — a handler that threw one produced total silence.
 */
function hostFor(url: string, method = "GET"): ArgumentsHost {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return {
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method, url }),
      getNext: () => undefined,
    }),
    switchToRpc: () => ({}) as ReturnType<ArgumentsHost["switchToRpc"]>,
    switchToWs: () => ({}) as ReturnType<ArgumentsHost["switchToWs"]>,
    getType: () => "http",
  } as ArgumentsHost;
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("expected domain failures are not actionable faults", () => {
  const filter = new AllExceptionsFilter();
  let reports: ErrorReport[];
  let capture: ReturnType<typeof captureStderr>;

  beforeEach(() => {
    reports = [];
    setErrorReporter({ report: (report) => reports.push(report) });
    capture = captureStderr();
  });
  afterEach(() => {
    capture.restore();
    resetErrorReporter();
  });

  it.each([
    ["404", new NotFoundException("Deal not found")],
    ["403", new ForbiddenException()],
    ["400", new BadRequestException("startDate must be before endDate")],
  ])("a %s neither logs at error level nor reaches the error reporter", (_label, exception) => {
    filter.catch(exception, hostFor("/crm/deals/42"));

    expect(reports).toHaveLength(0);
    expect(capture.lines).toHaveLength(0);
  });

  it.each([
    ["500", new InternalServerErrorException("index rebuild aborted")],
    ["503", new ServiceUnavailableException("provider drained")],
  ])("a deliberately raised %s is logged and reported", (_label, exception) => {
    filter.catch(exception, hostFor("/payroll/runs", "POST"));

    expect(reports).toHaveLength(1);
    expect(capture.lines.join("")).toContain("Server-side HttpException");
  });

  it("a 5xx on the health surface is logged but not reported, as the probe is not an incident", () => {
    filter.catch(new ServiceUnavailableException(), hostFor("/health/ready"));

    expect(reports).toHaveLength(0);
    expect(capture.lines.join("")).toContain("Server-side HttpException");
  });
});

describe("a query string is tenant data and stays out of the log line", () => {
  const filter = new AllExceptionsFilter();
  let capture: ReturnType<typeof captureStderr>;

  beforeEach(() => {
    setErrorReporter({ report: () => undefined });
    capture = captureStderr();
  });
  afterEach(() => {
    capture.restore();
    resetErrorReporter();
  });

  it("keeps the path and the filter names, and drops every supplied value", () => {
    filter.catch(
      new Error("projection missing"),
      hostFor("/crm/contacts?q=ada%40lovelace.example&stage=won"),
    );

    const joint = capture.lines.join("");
    expect(joint).toContain("/crm/contacts");
    expect(joint).toContain("queryKeys");
    expect(joint).toContain("stage");
    expect(joint).not.toContain("ada@lovelace.example");
    expect(joint).not.toContain("ada%40lovelace.example");
    expect(joint).not.toContain("won");
  });

  it("omits queryKeys entirely when the request carried none", () => {
    filter.catch(new Error("projection missing"), hostFor("/crm/contacts"));

    expect(capture.lines.join("")).not.toContain("queryKeys");
  });
});
