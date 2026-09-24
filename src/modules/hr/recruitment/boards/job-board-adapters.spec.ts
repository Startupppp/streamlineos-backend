import { outboundRequest } from "../../../../common/http/outbound-request";
import {
  ADAPTERS,
  BLOCKED_MESSAGE,
  BoardVendorError,
  resolveBoard,
  SUPPORTED_BOARDS,
} from "./job-board-adapters";
import type { ProviderCredentials } from "../integrations/provider-blocked";

jest.mock("../../../../common/http/outbound-request", () => ({
  outboundRequest: jest.fn(),
}));

const outbound = outboundRequest as jest.MockedFunction<typeof outboundRequest>;

const ACTIVE_WITH_TOKEN: ProviderCredentials = {
  platform: "LINKEDIN",
  isActive: true,
  token: "tok",
  meta: { baseUrl: "https://boards.test/api" },
};

function vendorSaid(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const POST = { jobId: 7, title: "Engineer", description: "d", location: "Bengaluru" };

beforeEach(() => outbound.mockReset());

describe("resolveBoard", () => {
  it("blocks a board the org has never connected", () => {
    expect(resolveBoard("LINKEDIN", null)).toMatchObject({
      status: "BLOCKED",
      code: "no-integration",
    });
  });

  it("blocks a board whose integration is switched off", () => {
    expect(resolveBoard("LINKEDIN", { ...ACTIVE_WITH_TOKEN, isActive: false })).toMatchObject({
      status: "BLOCKED",
      code: "inactive",
    });
  });

  it("blocks an active integration with no credentials, as needs-keys", () => {
    expect(resolveBoard("LINKEDIN", { ...ACTIVE_WITH_TOKEN, token: null })).toMatchObject({
      status: "BLOCKED",
      code: "needs-keys",
    });
  });

  it("blocks a platform nobody supports even when credentials exist", () => {
    expect(resolveBoard("MONSTER", { ...ACTIVE_WITH_TOKEN, platform: "MONSTER" })).toMatchObject({
      status: "BLOCKED",
      code: "not-implemented",
    });
  });

  it("resolves an adapter for a supported board with live credentials", () => {
    const resolved = resolveBoard("LINKEDIN", ACTIVE_WITH_TOKEN);
    expect("adapter" in resolved).toBe(true);
  });

  it("distinguishes missing keys from a missing adapter in what the recruiter reads", () => {
    expect(BLOCKED_MESSAGE["needs-keys"]).not.toBe(BLOCKED_MESSAGE["not-implemented"]);
    expect(BLOCKED_MESSAGE["not-implemented"]).toMatch(/yourself/i);
  });

  it("has an adapter for every board it claims to support", () => {
    expect([...ADAPTERS.keys()].sort()).toEqual([...SUPPORTED_BOARDS].sort());
  });
});

describe("a posting is only real when the vendor named it", () => {
  /**
   * The exact shape of the defect this replaces. The old code wrote
   * `{platform}-{jobId}-{timestamp}` as an external posting id without calling
   * anyone; the closest a vendor can come to that now is answering 200 with
   * nothing in it, and that has to be a failure — an "id" we invented cannot be
   * polled, closed, or shown to a recruiter as a link.
   */
  it("refuses a 2xx that carries no posting id", async () => {
    outbound.mockResolvedValue(vendorSaid(200, { ok: true }));
    const adapter = ADAPTERS.get("NAUKRI")!;
    await expect(adapter.post(ACTIVE_WITH_TOKEN, POST)).rejects.toThrow(/no posting id/i);
  });

  it("refuses a 2xx that is not JSON at all", async () => {
    outbound.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "",
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve("<html>"),
    } as unknown as Response);
    await expect(ADAPTERS.get("INDEED")!.post(ACTIVE_WITH_TOKEN, POST)).rejects.toThrow(/not JSON/i);
  });

  it("accepts a 2xx that names the posting, and keeps the vendor's id verbatim", async () => {
    outbound.mockResolvedValue(vendorSaid(201, { id: "NAU-99", url: "https://naukri.test/99" }));
    await expect(ADAPTERS.get("NAUKRI")!.post(ACTIVE_WITH_TOKEN, POST)).resolves.toEqual({
      externalPostingId: "NAU-99",
      url: "https://naukri.test/99",
    });
  });

  it("carries the vendor's status and words on a refusal", async () => {
    outbound.mockResolvedValue(vendorSaid(422, { error: "description too long" }));
    const error = await ADAPTERS.get("LINKEDIN")!
      .post(ACTIVE_WITH_TOKEN, POST)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoardVendorError);
    expect((error as BoardVendorError).httpStatus).toBe(422);
    expect((error as BoardVendorError).message).toMatch(/description too long/);
  });

  /**
   * A transport failure has no HTTP status, which is how the consumer tells
   * "retrying might work" from "the vendor has answered and said no".
   */
  it("reports a transport failure with no HTTP status", async () => {
    outbound.mockRejectedValue(new Error("socket hang up"));
    const error = await ADAPTERS.get("INDEED")!
      .post(ACTIVE_WITH_TOKEN, POST)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoardVendorError);
    expect((error as BoardVendorError).httpStatus).toBeNull();
  });

  it("sends the request to the org's configured base url", async () => {
    outbound.mockResolvedValue(vendorSaid(201, { id: "1" }));
    await ADAPTERS.get("NAUKRI")!.post(ACTIVE_WITH_TOKEN, POST);
    expect(outbound).toHaveBeenCalledWith(
      "https://boards.test/api/jobposting",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("status polling", () => {
  it("reads a closed advertisement as CLOSED rather than live", async () => {
    outbound.mockResolvedValue(vendorSaid(200, { status: "EXPIRED", applicantCount: 4 }));
    await expect(ADAPTERS.get("NAUKRI")!.pollStatus(ACTIVE_WITH_TOKEN, "NAU-99")).resolves.toMatchObject({
      state: "CLOSED",
      applicantCount: 4,
    });
  });

  it("reads a rejection as REJECTED", async () => {
    outbound.mockResolvedValue(vendorSaid(200, { state: "rejected" }));
    await expect(ADAPTERS.get("INDEED")!.pollStatus(ACTIVE_WITH_TOKEN, "1")).resolves.toMatchObject({
      state: "REJECTED",
    });
  });
});
