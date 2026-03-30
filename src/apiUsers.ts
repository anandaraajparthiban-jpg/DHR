import crypto from 'node:crypto';
import { dbAll, dbGet, dbRun } from './db.js';

export interface ApiUserAccount {
  id: string;
  username: string;
  subject: string;
  passwordHash: string;
  roles: Set<string>;
  scopes: Set<string>;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
}

export interface ApiUserCreateInput {
  username: string;
  subject: string;
  passwordHash: string;
  roles: Set<string>;
  scopes: Set<string>;
  isActive: boolean;
}

export interface ApiUserUpdateInput {
  subject?: string;
  passwordHash?: string;
  roles?: Set<string>;
  scopes?: Set<string>;
  isActive?: boolean;
}

interface ApiUserRow {
  id: string;
  username: string;
  subject: string;
  passwordHash: string;
  roles: string;
  scopes: string;
  isActive: number;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number | null;
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function normalizeSet(values: Set<string>): Set<string> {
  return new Set(
    Array.from(values)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  );
}

function decodeSet(raw: string): Set<string> {
  const text = String(raw ?? '').trim();
  if (!text) return new Set<string>();
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return normalizeSet(new Set(parsed.filter((v) => typeof v === 'string') as string[]));
    }
  } catch {
    // fall through to token split
  }
  const out = new Set<string>();
  const parts = text.includes(' ') ? text.split(' ') : text.split(',');
  for (const p of parts) {
    const n = p.trim().toLowerCase();
    if (n) out.add(n);
  }
  return out;
}

function encodeSet(values: Set<string>): string {
  const arr = Array.from(normalizeSet(values)).sort();
  return JSON.stringify(arr);
}

function mapRow(row: ApiUserRow | undefined): ApiUserAccount | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    username: row.username,
    subject: row.subject,
    passwordHash: row.passwordHash,
    roles: decodeSet(row.roles),
    scopes: decodeSet(row.scopes),
    isActive: Number(row.isActive) === 1,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    lastLoginAt:
      typeof row.lastLoginAt === 'number' && isFinite(row.lastLoginAt) ? Number(row.lastLoginAt) : undefined,
  };
}

export function apiUsernameKey(username: string): string {
  return normalizeUsername(username);
}

export async function getApiUserByUsername(username: string): Promise<ApiUserAccount | undefined> {
  const row = await dbGet<ApiUserRow>(
    `SELECT id, username, subject, password_hash AS "passwordHash", roles, scopes, is_active AS "isActive",
            created_at AS "createdAt", updated_at AS "updatedAt", last_login_at AS "lastLoginAt"
     FROM api_users WHERE username = ?`,
    [normalizeUsername(username)]
  );
  return mapRow(row);
}

export async function listApiUsers(): Promise<ApiUserAccount[]> {
  const rows = await dbAll<ApiUserRow>(
    `SELECT id, username, subject, password_hash AS "passwordHash", roles, scopes, is_active AS "isActive",
            created_at AS "createdAt", updated_at AS "updatedAt", last_login_at AS "lastLoginAt"
     FROM api_users
     ORDER BY username ASC`
  );
  return rows.map((r) => mapRow(r)!).filter(Boolean);
}

export async function createApiUser(input: ApiUserCreateInput): Promise<ApiUserAccount> {
  const username = normalizeUsername(input.username);
  const subject = input.subject.trim();
  const now = Date.now();
  const id = crypto.randomUUID();
  await dbRun(
    `INSERT INTO api_users
      (id, username, subject, password_hash, roles, scopes, is_active, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      username,
      subject,
      input.passwordHash,
      encodeSet(input.roles),
      encodeSet(input.scopes),
      input.isActive ? 1 : 0,
      now,
      now,
      null,
    ]
  );
  const created = await getApiUserByUsername(username);
  if (!created) throw new Error('Failed to create API user');
  return created;
}

export async function updateApiUser(username: string, input: ApiUserUpdateInput): Promise<ApiUserAccount | undefined> {
  const existing = await getApiUserByUsername(username);
  if (!existing) return undefined;

  const nextSubject = input.subject !== undefined ? input.subject.trim() : existing.subject;
  const nextPasswordHash = input.passwordHash !== undefined ? input.passwordHash : existing.passwordHash;
  const nextRoles = input.roles !== undefined ? input.roles : existing.roles;
  const nextScopes = input.scopes !== undefined ? input.scopes : existing.scopes;
  const nextIsActive = input.isActive !== undefined ? input.isActive : existing.isActive;

  await dbRun(
    `UPDATE api_users
     SET subject = ?, password_hash = ?, roles = ?, scopes = ?, is_active = ?, updated_at = ?
     WHERE username = ?`,
    [
      nextSubject,
      nextPasswordHash,
      encodeSet(nextRoles),
      encodeSet(nextScopes),
      nextIsActive ? 1 : 0,
      Date.now(),
      normalizeUsername(username),
    ]
  );

  return getApiUserByUsername(username);
}

export async function touchApiUserLastLogin(userId: string, atMs: number = Date.now()): Promise<void> {
  await dbRun('UPDATE api_users SET last_login_at = ?, updated_at = ? WHERE id = ?', [atMs, atMs, userId]);
}

export async function upsertApiUserIfMissing(input: ApiUserCreateInput): Promise<ApiUserAccount> {
  const existing = await getApiUserByUsername(input.username);
  if (existing) return existing;
  return createApiUser(input);
}
