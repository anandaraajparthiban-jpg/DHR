// pool.ts — ensure NiceHash pool exists for given algo/host/port/user; creates if needed (cached in-memory).
import { nhPrivateRequest } from './nhHttp.js';

interface PoolInput {
  algorithm: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  name?: string;
}

const poolCache = new Map<string, string>(); // key: algo|host|port|user -> poolId

export async function ensurePool(input: PoolInput): Promise<string> {
  const { algorithm, host, port, username, password = 'x', name = 'auto-pool' } = input;
  const key = `${algorithm}|${host}|${port}|${username}`.toLowerCase();
  if (poolCache.has(key)) return poolCache.get(key)!;

  const payload = {
    name,
    algorithm,
    stratumHostname: host,
    stratumPort: port,
    username,
    password,
  };

  const data: any = await nhPrivateRequest('POST', '/main/api/v2/pool', { body: payload });
  const poolId = data?.id;
  if (!poolId) throw new Error('pool create missing id');

  const poolIdStr = String(poolId);
  poolCache.set(key, poolIdStr);
  return poolIdStr;
}
