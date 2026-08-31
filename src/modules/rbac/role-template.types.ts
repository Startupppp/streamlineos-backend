export interface RoleTemplate {
  id: string;
  name: string;
  slug: string;
  moduleKey: string | null;
  permissions: readonly string[];
}
