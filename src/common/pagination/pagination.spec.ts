import { paginateOffset, buildListResponse } from "./pagination";

describe("pagination", () => {
  it("computes limit/offset", () => {
    expect(paginateOffset({ page: 3, pageSize: 20 })).toEqual({ limit: 20, offset: 40 });
  });

  it("builds the list envelope", () => {
    expect(buildListResponse([1, 2], 42, { page: 1, pageSize: 20 })).toEqual({
      items: [1, 2],
      total: 42,
      page: 1,
      pageSize: 20,
      totalPages: 3,
    });
  });

  it("returns totalPages 0 when empty", () => {
    expect(buildListResponse([], 0, { page: 1, pageSize: 20 }).totalPages).toBe(0);
  });
});
