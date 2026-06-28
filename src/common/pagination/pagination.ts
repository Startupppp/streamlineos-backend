export interface PageParams {
  page: number;
  pageSize: number;
}

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const PAGE_SIZE_MAX = 100;

export function paginateOffset({ page, pageSize }: PageParams): { limit: number; offset: number } {
  const size = Math.min(pageSize, PAGE_SIZE_MAX);
  return { limit: size, offset: (page - 1) * size };
}

export function buildListResponse<T>(items: T[], total: number, { page, pageSize }: PageParams): ListResponse<T> {
  return { items, total, page, pageSize, totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0 };
}
