/** [GATE] Types of server/gate-worker/worker.js (plain JS, deployed as is) for the unit tests. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}
export interface GateEnv {
  DB: D1Like;
}
export const GATE_HASH_PREFIX: string;
export const MAX_BODY_BYTES: number;
export const MAX_CODE_CHARS: number;
export const MIN_CODE_LEN: number;
export const MAX_CODE_LEN: number;
export const DEVICE_RE: RegExp;
export function normaliseCode(input: string): string;
export function hashCode(code: string): Promise<string>;
export function parseRedeemBody(text: string): { code: string; device: string } | string;
export function redeem(db: D1Like, code: string, device: string, now?: number): Promise<'ok' | 'used' | 'wrong'>;
export function handle(request: Request, env: GateEnv): Promise<Response>;
declare const worker: { fetch(request: Request, env: GateEnv): Promise<Response> };
export default worker;
