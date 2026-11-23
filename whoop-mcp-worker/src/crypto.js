// Web Crypto helpers. The AES-256-GCM layout (iv | tag | ciphertext) matches the Node
// server's state.enc file byte for byte, so a file from that server can be imported as-is.
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = {
  encode: (bytes) => btoa(String.fromCharCode(...bytes)),
  decode: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
export const b64url = {
  encode: (bytes) => b64.encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
};

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export const newToken = (bytes = 32) => b64url.encode(randomBytes(bytes));
export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}
export const hashToken = async (t) => hex(await sha256(t));
export const sha256b64url = async (s) => b64url.encode(await sha256(s));

/** Constant-time comparison of two strings of the same length. */
export function timingSafeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const aesKey = (keyBytes) => crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

export async function encrypt(keyBytes, plaintext) {
  const iv = randomBytes(12);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keyBytes), enc.encode(plaintext)));
  const data = out.subarray(0, out.length - 16), tag = out.subarray(out.length - 16);
  const buf = new Uint8Array(12 + 16 + data.length);
  buf.set(iv, 0); buf.set(tag, 12); buf.set(data, 28);
  return buf;
}

export async function decrypt(keyBytes, buf) {
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  const joined = new Uint8Array(data.length + 16);
  joined.set(data, 0); joined.set(tag, data.length);
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aesKey(keyBytes), joined));
}
