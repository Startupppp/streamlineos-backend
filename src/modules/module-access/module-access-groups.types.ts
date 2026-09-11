import type { DataScope } from "../access/access.types";

export interface ModuleRoleGroup {
  id: number;
  name: string;
  isSystem: boolean;
  version: number;
  memberCount: number;
  permissions: { permissionKey: string; scope: DataScope }[];
}

export interface ModuleMemberCandidate {
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

export interface FlatModuleMember {
  membershipId: number;
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  groups: { id: number; name: string }[];
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface MembersPage {
  data: FlatModuleMember[];
  hasMore: boolean;
  nextCursor: number | null;
}
