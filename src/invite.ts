// Invite = a short link/QR. The secret sits after '#', so it is never sent to the web server.
import { hkdf } from './crypto';
import { b64, concat, td, te, U8, unb64 } from './util';

export interface Invite { secure: boolean; reusable: boolean; secret: U8; exp: number; relays?: string[] }

export function encodeInvite(i: Invite): string {
  const flags = (i.secure ? 1 : 0) | (i.reusable ? 2 : 0) | (i.relays?.length ? 4 : 0);
  const e = i.exp >>> 0;
  return b64(concat([1, flags], i.secret, [e >>> 24, (e >>> 16) & 255, (e >>> 8) & 255, e & 255],
    i.relays?.length ? te.encode(i.relays.join('\n')) : []));
}
export function decodeInvite(s: string): Invite | null {
  try {
    const u = unb64(s);
    if (u.length < 22 || u[0] !== 1) return null;
    const exp = ((u[18] << 24) | (u[19] << 16) | (u[20] << 8) | u[21]) >>> 0;
    const relays = u[1] & 4 ? td.decode(u.subarray(22)).split('\n').filter(x => /^wss:\/\/[^\s]+$/.test(x) || /^ws:\/\/(127\.0\.0\.1|localhost)[:/]/.test(x)).slice(0, 6) : undefined;
    return { secure: !!(u[1] & 1), reusable: !!(u[1] & 2), secret: u.slice(2, 18), exp, relays };
  } catch { return null; }
}
export const baseUrl = () => location.origin + location.pathname;
export const inviteUrl = (kind: 'j' | 'p', i: Invite) => baseUrl() + '#' + kind + '=' + encodeInvite(i);
/** Public room id / relay topic: derived one-way from the secret. */
export const roomId = async (secret: U8) => b64(await hkdf(secret, null, 'vz1/topic', 12));
