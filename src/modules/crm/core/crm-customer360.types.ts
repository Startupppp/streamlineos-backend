export const SECTION_LIMIT = 10;

export interface Customer360Section<T> {
  items: T[];
  total: number;
}

export interface Customer360Response {
  contacts?: Customer360Section<unknown>;
  leads?: Customer360Section<unknown>;
  deals?: Customer360Section<unknown>;
  quotes?: Customer360Section<unknown>;
  invoices?: Customer360Section<unknown>;
  payments?: Customer360Section<unknown>;
  supportTickets?: Customer360Section<unknown>;
  surveys?: Customer360Section<unknown>;
  activities?: Customer360Section<unknown>;
  projects?: Customer360Section<unknown>;
  signedDocuments?: Customer360Section<unknown>;
}
