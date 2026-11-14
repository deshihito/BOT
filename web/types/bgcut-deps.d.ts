// 背景透過ページで使う、型定義を持たない依存の最小宣言。
declare module "gifuct-js" {
  export type GifFrame = {
    dims: { width: number; height: number; top: number; left: number };
    patch: Uint8ClampedArray;
    delay: number;
    disposalType: number;
  };
  export function parseGIF(arrayBuffer: ArrayBuffer): unknown;
  export function decompressFrames(gif: unknown, buildPatch: boolean): GifFrame[];
}

declare module "gifenc" {
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: string },
  ): number[][];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: string,
  ): Uint8Array;
  export type GifEncoderInstance = {
    writeFrame: (
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: number[][];
        first?: boolean;
        transparent?: boolean;
        transparentIndex?: number;
        delay?: number;
        repeat?: number;
      },
    ) => void;
    finish: () => void;
    bytes: () => Uint8Array;
    reset: () => void;
  };
  export function GIFEncoder(opts?: { auto?: boolean }): GifEncoderInstance;
}

declare module "upng-js" {
  const UPNG: {
    encode: (
      frames: ArrayBuffer[],
      width: number,
      height: number,
      colors: number,
    ) => ArrayBuffer;
    decode: (buffer: ArrayBuffer) => unknown;
    toRGBA8: (img: unknown) => ArrayBuffer[];
  };
  export default UPNG;
}
