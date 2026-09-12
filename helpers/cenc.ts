// CENC fMP4 decryption via Bento4's mp4decrypt.
//
// DRM VOD (Tubi, Pluto) ships fragmented-MP4 segments encrypted with Common
// Encryption (Widevine/PlayReady CENC). Given the content keys, mp4decrypt
// transmuxes an encrypted fMP4 (init + fragments) into clear fMP4 — it rewrites
// the sample descriptions (encv→avc1), strips the encryption boxes, and
// decrypts the samples. We run it per (init+segment) pair and split the result
// at the first `moof` box so the client can fetch a clear init segment and
// clear media segments separately, exactly as for non-DRM content.
//
// A native TS AES-128-CTR decryptor was attempted, but decrypting mdat in place
// leaves the init's `encv`/`sinf` boxes intact, which players reject once the
// EXT-X-KEY is stripped. mp4decrypt does the full transmux and Just Works.

import type { ContentKeys } from './widevine';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Walk top-level MP4 boxes; return the byte offset of the first box of `type`,
// or -1. Handles 32-bit and 64-bit (size==1) box sizes.
export function boxOffset(buf: Uint8Array, type: string): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = dv.getUint32(off);
    const boxType = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    let headerLen = 8;
    if (size === 1) { size = Number(dv.getBigUint64(off + 8)); headerLen = 16; }
    else if (size === 0) { size = buf.length - off; }
    if (boxType === type) return off;
    if (size < headerLen) break; // malformed
    off += size;
  }
  return -1;
}

// Run mp4decrypt over `input` with the given content keys. Returns clear fMP4.
export async function mp4decrypt(input: Uint8Array, keys: ContentKeys): Promise<Uint8Array> {
  const tag = randomBytes(8).toString('hex');
  const inPath = join(tmpdir(), `snagger-cenc-${tag}.in.mp4`);
  const outPath = join(tmpdir(), `snagger-cenc-${tag}.out.mp4`);
  await Bun.write(inPath, input);

  const args = ['mp4decrypt'];
  for (const [kid, key] of Object.entries(keys)) args.push('--key', `${kid}:${key}`);
  args.push(inPath, outPath);

  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) throw new Error(`mp4decrypt exit ${code}: ${err.slice(0, 200)}`);
    return await Bun.file(outPath).bytes();
  } finally {
    try { await Bun.file(inPath).unlink(); } catch {}
    try { await Bun.file(outPath).unlink(); } catch {}
  }
}

export interface ClearParts {
  init: Uint8Array;      // ftyp…moov (clear init segment)
  fragment: Uint8Array;  // moof…end (clear media segment)
}

// Decrypt an (encryptedInit + encryptedSegment) buffer and split the clear
// result into the init portion and the media-fragment portion.
export async function decryptAndSplit(
  encInit: Uint8Array,
  encSegment: Uint8Array,
  keys: ContentKeys,
): Promise<ClearParts> {
  const combined = new Uint8Array(encInit.length + encSegment.length);
  combined.set(encInit, 0);
  combined.set(encSegment, encInit.length);
  const clear = await mp4decrypt(combined, keys);
  const moofAt = boxOffset(clear, 'moof');
  if (moofAt < 0) throw new Error('decrypted fMP4 has no moof box');
  return { init: clear.slice(0, moofAt), fragment: clear.slice(moofAt) };
}
