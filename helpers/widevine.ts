// Widevine content-key fetcher — thin wrapper over helpers/wvcdm.py (pywidevine).
//
// Given a PSSH + license server URL (+ any auth headers), returns the content
// keys as { kidHex: keyHex }. Keys are cached in-process by an arbitrary cache
// key (typically the content id) since they never change for a given title.
//
// A native TS implementation of the Widevine protocol was attempted but the
// license server rejected its challenges (the signing/KDF is easy to get
// subtly wrong). pywidevine is the proven, reliable path; the only cost is a
// Python subprocess per new title (cached thereafter).

const PY = '.venv/bin/python';
const CDM_SCRIPT = 'helpers/wvcdm.py';
const WVD = 'device.wvd';

export type ContentKeys = Record<string, string>; // kidHex -> keyHex

const keyCache = new Map<string, ContentKeys>();

export interface LicenseRequest {
  cacheKey: string;          // e.g. the content id — used only for caching
  pssh: string;              // base64 PSSH box
  licenseUrl: string;        // full license URL (auth/drm token already embedded)
  headers?: Record<string, string>;
}

export async function getContentKeys(req: LicenseRequest): Promise<ContentKeys> {
  const cached = keyCache.get(req.cacheKey);
  if (cached) return cached;

  const proc = Bun.spawn([PY, CDM_SCRIPT], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  proc.stdin.write(JSON.stringify({
    device: WVD,
    pssh: req.pssh,
    licenseUrl: req.licenseUrl,
    headers: req.headers ?? {},
  }));
  await proc.stdin.end();

  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;

  let parsed: { keys?: ContentKeys; error?: string };
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    throw new Error(`widevine: unparseable CDM output: ${out.slice(0, 200)} ${err.slice(0, 200)}`);
  }
  if (parsed.error) throw new Error(`widevine: ${parsed.error}`);
  const keys = parsed.keys ?? {};
  if (Object.keys(keys).length === 0) throw new Error('widevine: no content keys returned');

  keyCache.set(req.cacheKey, keys);
  console.log(`[widevine] ${Object.keys(keys).length} content key(s) for ${req.cacheKey}`);
  return keys;
}
