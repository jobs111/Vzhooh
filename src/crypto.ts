// All cryptography goes through the browser's built-in WebCrypto: no home-made ciphers.
import { b64, bs, concat, rnd, te, U8, unb64 } from './util';

const S = crypto.subtle;
const EMPTY = new Uint8Array(0);

export async function hkdf(ikm: U8, salt: U8 | null, info: string | U8, len: number): Promise<U8> {
  const k = await S.importKey('raw', bs(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await S.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: bs(salt || EMPTY), info: bs(typeof info === 'string' ? te.encode(info) : info) },
    k, len * 8);
  return new Uint8Array(bits);
}
export const aesKey = (raw: U8) => S.importKey('raw', bs(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);

/** AES-256-GCM with a random 96-bit nonce. Output: nonce | ciphertext+tag. */
export async function seal(key: CryptoKey, plain: U8, aad: U8): Promise<U8> {
  const iv = rnd(12);
  const ct = await S.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad) }, key, bs(plain));
  return concat(iv, new Uint8Array(ct));
}
export async function unseal(key: CryptoKey, data: U8, aad: U8): Promise<U8 | null> {
  if (data.length < 28) return null;
  try {
    const pt = await S.decrypt({ name: 'AES-GCM', iv: bs(data.subarray(0, 12)), additionalData: bs(aad) }, key, bs(data.subarray(12)));
    return new Uint8Array(pt);
  } catch { return null; }
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
export interface KeyPair { priv: CryptoKey; pub: U8 }
export async function ecdhGen(): Promise<KeyPair> {
  const kp = await S.generateKey(ECDH, false, ['deriveBits']);
  return { priv: kp.privateKey, pub: new Uint8Array(await S.exportKey('raw', kp.publicKey)) };
}
export async function ecdh(priv: CryptoKey, peerPub: U8): Promise<U8> {
  const pub = await S.importKey('raw', bs(peerPub), ECDH, false, []);
  return new Uint8Array(await S.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
}
export async function hmac(key: U8, data: U8): Promise<U8> {
  const k = await S.importKey('raw', bs(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await S.sign('HMAC', k, bs(data)));
}
export const sha256 = async (d: U8) => new Uint8Array(await S.digest('SHA-256', bs(d)));

const EMOJI = ('🐶 🐱 🦊 🐻 🐼 🐸 🐵 🦁 🐯 🐮 🐷 🐔 🐧 🦉 🦄 🐝 🦋 🐢 🐙 🐬 🐳 🦖 🌵 🌲 🌻 🍄 🍎 🍋 🍉 🍇 🍓 🍒 ' +
  '🥕 🌽 🍕 🍔 🍩 🍪 🎂 ☕ ⚽ 🏀 🎲 🎸 🎹 🎧 🎈 🎁 🚗 🚀 ✈️ ⛵ 🚲 🏠 ⛰️ 🌙 ⭐ ☀️ ⚡ 🔥 ❄️ 🌈 💎 🔑').split(' ');
/** Short authentication string: 4 emoji (24 bits) both sides compare to detect a man-in-the-middle. */
export function sasEmoji(b: U8): string {
  const n = (b[0] << 16) | (b[1] << 8) | b[2];
  return [18, 12, 6, 0].map(s => EMOJI[(n >> s) & 63]).join(' ');
}

// ---- Owner key: ECDSA P-256 private key encrypted with a passphrase (PBKDF2 → AES-GCM). ----
// The file is public (lives in the repo); only someone who knows the passphrase can unlock it.
export interface OwnerFile { v: 1; salt: string; iter: number; pub: string; enc: string }
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

async function passKey(pass: string, salt: U8, iter: number): Promise<CryptoKey> {
  const base = await S.importKey('raw', bs(te.encode(pass.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey']);
  return S.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: bs(salt), iterations: iter }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function ownerCreate(pass: string): Promise<OwnerFile> {
  const kp = await S.generateKey(ECDSA, true, ['sign', 'verify']);
  const salt = rnd(16), iter = 600000;
  const pkcs8 = new Uint8Array(await S.exportKey('pkcs8', kp.privateKey));
  const enc = await seal(await passKey(pass, salt, iter), pkcs8, te.encode('vz1/owner'));
  return { v: 1, salt: b64(salt), iter, pub: b64(new Uint8Array(await S.exportKey('raw', kp.publicKey))), enc: b64(enc) };
}
export async function ownerUnlock(f: OwnerFile, pass: string): Promise<CryptoKey | null> {
  const pkcs8 = await unseal(await passKey(pass, unb64(f.salt), f.iter), unb64(f.enc), te.encode('vz1/owner'));
  if (!pkcs8) return null;
  return S.importKey('pkcs8', bs(pkcs8), ECDSA, false, ['sign']);
}
export const ownerSign = async (priv: CryptoKey, data: U8) => new Uint8Array(await S.sign(SIGN, priv, bs(data)));
export async function ownerVerify(pubRaw: U8, sig: U8, data: U8): Promise<boolean> {
  try {
    const pub = await S.importKey('raw', bs(pubRaw), ECDSA, false, ['verify']);
    return await S.verify(SIGN, pub, bs(sig), bs(data));
  } catch { return false; }
}

// ---- Delegated admin devices: the owner signs another device's own key ("certificate"). ----
export interface AdminCert { pub: string; sig: string; exp: number }
export async function deviceKeyGen(): Promise<{ key: CryptoKey; pub: U8 }> {
  const kp = await S.generateKey(ECDSA, false, ['sign', 'verify']);
  return { key: kp.privateKey, pub: new Uint8Array(await S.exportKey('raw', kp.publicKey)) };
}
export const certData = (pub: U8, exp: number) => concat(te.encode('vz1/adm'), pub, te.encode(String(exp)));
/** Was this handshake transcript signed by the owner, or by a device the owner certified? */
export async function verifyHost(ownerPub: U8, sig: U8, tr: U8, cert?: { dk?: unknown; dc?: unknown; dx?: unknown }): Promise<boolean> {
  if (cert && typeof cert.dk === 'string' && typeof cert.dc === 'string') {
    const dk = unb64(cert.dk), exp = +(cert.dx as number) || 0;
    if (exp < Date.now()) return false;
    if (!(await ownerVerify(ownerPub, unb64(cert.dc), certData(dk, exp)))) return false;
    return ownerVerify(dk, sig, tr);
  }
  return ownerVerify(ownerPub, sig, tr);
}
