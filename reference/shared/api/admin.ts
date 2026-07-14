// Request/response shapes for the admin endpoints:
//  - /api/admin/users*
//  - /api/admin/projects*
//
// All admin routes require both `authenticateToken` and `requireAdmin`
// middleware. The shapes below are admin-specific and never exposed to
// non-admins.

import type { ProjectRow, UserRow } from '../types/db';
import { expectType } from './_common';

// ---- Users ---------------------------------------------------------------

// `userDb.getAllUsers()` projects a deliberately narrow column set —
// `password_hash`, `api_key_hash`, etc. never leave the DB.
export interface AdminUserListItem {
  id: number;
  username: string;
  created_at: string;
  last_login: string | null;
  is_active: 0 | 1;
  is_admin: 0 | 1;
  is_technical: 0 | 1;
}

export type ListAdminUsersResponse = AdminUserListItem[];

export interface CreateAdminUserRequest {
  username: string;
  password: string;
  is_admin?: boolean;
}

export interface CreateAdminUserResponse {
  id: number;
  username: string;
  // Echoed from the request, not from DB. Coerced to boolean server-side.
  is_admin: boolean;
}

export interface UpdateAdminUserRequest {
  username?: string;
  password?: string;
  is_active?: boolean;
  is_admin?: boolean;
}

// `userDb.updateUser` returns the full row minus sensitive fields; matches
// the shape of `getUserById` (no password_hash).
export type UpdateAdminUserResponse = Omit<UserRow, 'password_hash' | 'api_key_hash'>;

export interface DeleteAdminUserResponse {
  success: true;
}

// ---- Projects ------------------------------------------------------------

// `GET /api/admin/projects` decorates each `ProjectRow` with `memberCount`
// for the admin project list page.
export type AdminProjectListItem = ProjectRow & { memberCount: number };

export type ListAdminProjectsResponse = AdminProjectListItem[];

export type GitHubAppHealthErrorCode =
  | 'GITHUB_APP_NOT_CONFIGURED'
  | 'GITHUB_APP_KEY_INVALID'
  | 'GITHUB_INSTALLATION_NOT_FOUND'
  | 'GITHUB_INSTALLATION_SUSPENDED'
  | 'GITHUB_REPOSITORY_NOT_SELECTED'
  | 'GITHUB_APP_PERMISSION_MISSING'
  | 'GITHUB_APP_TOKEN_FAILED';

export interface GitHubAppHealthResponse {
  mode: 'host' | 'app';
  status: 'disabled' | 'healthy' | 'degraded' | 'error';
  configured: boolean;
  appId: number | null;
  appSlug: string | null;
  botLogin: string | null;
  botUserId: number | null;
  webhookConfigured: boolean;
  webhookUrl: string | null;
  lastMetadataSuccessAt: number | null;
  lastTokenMintSuccessAt: number | null;
  errorCode: GitHubAppHealthErrorCode | null;
  error: string | null;
}

// Project member rows joined with user info — surfaced via the admin
// "manage members" panel.
export interface ProjectMemberListItem {
  id: number;
  username: string;
  created_at: string;
  is_admin: 0 | 1;
  joined_at: string;
}

export type GetProjectMembersResponse = ProjectMemberListItem[];

export interface AddProjectMemberRequest {
  userId: number;
}

export interface AddProjectMemberResponse {
  success: true;
}

export interface RemoveProjectMemberResponse {
  success: true;
}

// ---- Type-level smoke checks ---------------------------------------------

expectType<AdminProjectListItem['memberCount']>(0);
expectType<UpdateAdminUserResponse['id']>(0);
