// PASTE-006: read the target's character counter from the KVM video stream.
//
// USB HID gives no host→device feedback about what actually landed, but the
// video the KVM already renders contains the target's own counter (e.g.
// Notepad's status bar). OCR-ing that region closes the loop: after each
// paste chunk the frontend can confirm the count itself instead of asking
// the user to glance. Spike-validated 8/8 exact on real KVM captures (see
// docs/tickets/PASTE-006.md).
//
// tesseract.js is lazy-loaded on first use so the ~MBs of wasm/traineddata
// are only fetched when auto-verify is actually enabled.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TesseractWorker = any;

export interface CounterRegion {
  // Native video pixels (videoWidth/videoHeight space).
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CounterCalibration {
  region: CounterRegion;
  value: number;
}

let workerPromise: Promise<TesseractWorker> | null = null;

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng");
      await worker.setParameters({
        tessedit_char_whitelist: "0123456789,characters ",
      });
      return worker;
    })();
  }
  return workerPromise;
}

function grabRegion(
  video: HTMLVideoElement,
  region: CounterRegion,
  scale: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(region.w * scale));
  canvas.height = Math.max(1, Math.round(region.h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(video, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

// Locate "<number> characters" anywhere in the bottom strip of the frame —
// status bars live there. Returns the (padded) region in native video
// coordinates plus the value read, or null when no counter is visible.
export async function findCounter(video: HTMLVideoElement): Promise<CounterCalibration | null> {
  if (!video.videoWidth || !video.videoHeight) return null;
  const worker = await getWorker();
  const SCALE = 1.5;
  const strip: CounterRegion = {
    x: 0,
    y: Math.floor(video.videoHeight * 0.6),
    w: video.videoWidth,
    h: video.videoHeight - Math.floor(video.videoHeight * 0.6),
  };
  const canvas = grabRegion(video, strip, SCALE);
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  const words: OcrWord[] = (data.blocks ?? []).flatMap(
    (b: { paragraphs?: { lines?: { words?: OcrWord[] }[] }[] }) =>
      (b.paragraphs ?? []).flatMap(p => (p.lines ?? []).flatMap(l => l.words ?? [])),
  );
  for (let i = 1; i < words.length; i++) {
    if (!/^characters/i.test(words[i].text)) continue;
    const numText = words[i - 1].text.replace(/[^\d,]/g, "");
    const value = parseInt(numText.replace(/,/g, ""), 10);
    if (!Number.isFinite(value)) continue;
    const b0 = words[i - 1].bbox; // the number
    const b1 = words[i].bbox; // the word "characters"
    const padY = 12;
    // In a left-aligned status-bar segment the NUMBER's left edge is fixed;
    // as the count grows it extends rightward and pushes "characters" right.
    // So calibrating tightly on the initial (often "0 characters") value and
    // reusing that box loses the right side once the count grows — the actual
    // bug observed in the field. Anchor on the stable left edge and extend
    // the region generously to the right (enough for "9,999,999 characters")
    // so every later read still contains the full "N characters" string.
    const smallLeftPad = 18;
    const rightExtent = 360; // native px past the number's left edge
    const xLeft = b0.x0 / SCALE + strip.x - smallLeftPad;
    const x0 = Math.max(0, xLeft);
    const y0 = Math.max(0, Math.min(b0.y0, b1.y0) / SCALE + strip.y - padY);
    const y1 = Math.max(b0.y1, b1.y1) / SCALE + strip.y + padY;
    return {
      region: {
        x: Math.round(x0),
        y: Math.round(y0),
        w: Math.round(rightExtent + (xLeft - x0)),
        h: Math.round(y1 - y0),
      },
      value,
    };
  }
  return null;
}

// Read the counter from a previously located region. Returns null when the
// region no longer parses (window moved, focus lost, etc.).
export async function readCounter(
  video: HTMLVideoElement,
  region: CounterRegion,
): Promise<number | null> {
  if (!video.videoWidth || !video.videoHeight) return null;
  const worker = await getWorker();
  const canvas = grabRegion(video, region, 3);
  const { data } = await worker.recognize(canvas);
  const match = (data.text ?? "").match(/([\d,]+)\s*characters/i);
  if (!match) return null;
  const value = parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isFinite(value) ? value : null;
}
