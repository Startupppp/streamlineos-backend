export interface ExportScope {
  orgId: string;
  warehouseIds?: number[];
}

export function buildExportScope(orgId: string): ExportScope {
  return { orgId };
}
