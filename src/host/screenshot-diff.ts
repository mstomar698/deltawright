import { PNG } from 'pngjs';

export interface ChangedRegion {
  /** The changed pixel bounds, in the SCREENSHOT's pixel space. NOTE: on a HiDPI viewport
   *  (`deviceScaleFactor > 1`) the screenshot is scaled, so this rect is in DEVICE pixels — divide by
   *  the device scale factor to compare with CSS-pixel DOM geometry. */
  rect: { x: number; y: number; width: number; height: number };
  changedPixels: number;
}

export interface DiffOptions {
  /** Per-channel difference (0..255) above which a pixel counts as changed. */
  channelThreshold?: number;
  /** Ignore diffs with fewer than this many changed pixels (noise / antialiasing). */
  minPixels?: number;
}

/**
 * Direct pixel diff of two viewport PNG screenshots (devicePixelRatio 1). Returns the
 * bounding box of changed pixels, or null if the images differ in size or the change
 * is below the noise floor. This is the DOM-less fallback (#20) for canvas / WebGL /
 * cross-origin regions where an action changes pixels but mutates no DOM.
 */
export function diffChangedRegion(
  before: Buffer,
  after: Buffer,
  opts: DiffOptions = {},
): ChangedRegion | null {
  const a = PNG.sync.read(before);
  const b = PNG.sync.read(after);
  if (a.width !== b.width || a.height !== b.height) return null; // resize is not a region change
  const thr = opts.channelThreshold ?? 24;
  const minPixels = opts.minPixels ?? 25;
  const { width, height } = a;
  const da = a.data;
  const db = b.data;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let changed = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (
        Math.abs((da[i] ?? 0) - (db[i] ?? 0)) > thr ||
        Math.abs((da[i + 1] ?? 0) - (db[i + 1] ?? 0)) > thr ||
        Math.abs((da[i + 2] ?? 0) - (db[i + 2] ?? 0)) > thr
      ) {
        changed++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (changed < minPixels || maxX < 0) return null;
  return {
    rect: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    changedPixels: changed,
  };
}
