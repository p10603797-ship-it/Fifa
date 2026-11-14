/** [GATE] Types of server/gate-worker/worker.js (plain JS, deployed as is) for the unit tests. */
export interface SqlLike {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] };
}
export interface StoreStub {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}
export interface GateEnv {
  GATE: { idFromName(name: string): unknown; get(id: unknown): StoreStub };
}
export const GATE_HASH_PREFIX: string;
export const MAX_BODY_BYTES: number;
export const MAX_CODE_CHARS: number;
export const MIN_CODE_LEN: number;
export const MAX_CODE_LEN: number;
export const DEVICE_RE: RegExp;
export const VALID_HASHES: Set<string>;
export class GateStore {
  constructor(ctx: { storage: { sql: SqlLike } });
  claim(hash: string, device: string, now: number): 'ok' | 'used';
  usedCount(): number;
  fetch(request: Request): Promise<Response>;
}
export function normaliseCode(input: string): string;
export function hashCode(code: string): Promise<string>;
export function parseRedeemBody(text: string): { code: string; device: string } | string;
export function redeem(env: GateEnv, code: string, device: string, now?: number): Promise<'ok' | 'used' | 'wrong'>;
export function handle(request: Request, env: GateEnv): Promise<Response>;
declare const worker: { fetch(request: Request, env: GateEnv): Promise<Response> };
export default worker;
