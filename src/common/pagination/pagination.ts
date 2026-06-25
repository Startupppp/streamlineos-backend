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

export function paginateOffset({ page, pageSize }: PageParams): { limit: number; offset: number } {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

export function buildListResponse<T>(items: T[], total: number, { page, pageSize }: PageParams): ListResponse<T> {
  return { items, total, page, pageSize, totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0 };
}
