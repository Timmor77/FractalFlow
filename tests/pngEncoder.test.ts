// Streaming PNG encoder.
//
// The encoder is checked with a decoder written here from the specification,
// sharing no code with it: chunk CRCs are recomputed bit by bit, the zlib
// stream is inflated by the platform, and every row is un-filtered. What comes
// out must be the pixels that went in.

import { describe, it, expect } from "vitest";
import { PngStreamEncoder, crc32 } from "../src/export/pngEncoder";

// Bitwise CRC-32, deliberately not table-driven like the implementation.
function slowCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

type Decoded = {
  width: number;
  height: number;
  rgb: Uint8Array;
  filters: number[];
  idatCount: number;
};

async function decodePng(blob: Blob): Promise<Decoded> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const view = new DataView(bytes.buffer);
  const types: string[] = [];
  const idat: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const crc = view.getUint32(offset + 8 + length);
    expect(crc, `CRC of ${type}`).toBe(slowCrc(bytes.subarray(offset + 4, offset + 8 + length)));
    types.push(type);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      // 8-bit truecolour, deflate, adaptive filtering, no interlace.
      expect([...data.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += 12 + length;
  }
  expect(types[0]).toBe("IHDR");
  expect(types[types.length - 1]).toBe("IEND");

  const compressed = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of idat) {
    compressed.set(part, at);
    at += part.length;
  }
  const stream = await inflate(compressed);
  const rowBytes = width * 3;
  expect(stream.length).toBe(height * (rowBytes + 1));

  const rgb = new Uint8Array(height * rowBytes);
  const filters: number[] = [];
  for (let y = 0; y < height; y++) {
    const filter = stream[y * (rowBytes + 1)];
    filters.push(filter);
    for (let i = 0; i < rowBytes; i++) {
      const x = stream[y * (rowBytes + 1) + 1 + i];
      const a = i >= 3 ? rgb[y * rowBytes + i - 3] : 0;
      const b = y > 0 ? rgb[(y - 1) * rowBytes + i] : 0;
      const c = i >= 3 && y > 0 ? rgb[(y - 1) * rowBytes + i - 3] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? (a + b) >> 1
                : paeth(a, b, c);
      rgb[y * rowBytes + i] = (x + predictor) & 0xff;
    }
  }
  return { width, height, rgb, filters, idatCount: idat.length };
}

// Deterministic pseudo-random bytes (the test must not depend on Math.random).
function noise(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

describe("crc32", () => {
  it("matches the reference value of the IEND chunk", () => {
    // Every PNG ends with 00 00 00 00 "IEND" AE 42 60 82.
    const iend = new Uint8Array([0x49, 0x45, 0x4e, 0x44]);
    expect((crc32(iend) ^ 0xffffffff) >>> 0).toBe(0xae426082);
  });
});

describe("PngStreamEncoder", () => {
  it("round-trips an image written in uneven bands", async () => {
    const [width, height] = [37, 29];
    const rgb = new Uint8Array(width * height * 3);
    // Left half: smooth gradient (what the filters are for). Right half: noise.
    const random = noise(rgb.length, 7);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        const smooth = x < width / 2;
        rgb[i] = smooth ? x * 6 : random[i];
        rgb[i + 1] = smooth ? y * 8 : random[i + 1];
        rgb[i + 2] = smooth ? (x + y) * 3 : random[i + 2];
      }
    }

    const encoder = new PngStreamEncoder(width, height);
    const rowBytes = width * 3;
    let row = 0;
    for (const rows of [1, 10, 7, 11]) {
      await encoder.writeRows(rgb.subarray(row * rowBytes, (row + rows) * rowBytes));
      row += rows;
    }
    const blob = await encoder.finish();
    expect(blob.type).toBe("image/png");

    const decoded = await decodePng(blob);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.rgb).toEqual(rgb);
  });

  it("does not keep a reference to the caller's buffer", async () => {
    // The exporter reuses nothing today, but a band buffer overwritten after
    // writeRows must not corrupt the Up / Paeth prediction of the next rows.
    const [width, height] = [16, 8];
    const original = noise(width * height * 3, 99);
    const encoder = new PngStreamEncoder(width, height);
    const half = original.length / 2;
    const scratch = original.slice(0, half);
    await encoder.writeRows(scratch);
    scratch.fill(0xaa);
    await encoder.writeRows(original.subarray(half));
    const decoded = await decodePng(await encoder.finish());
    expect(decoded.rgb).toEqual(original);
  });

  it("picks a predictive filter that flattens a gradient", async () => {
    const [width, height] = [64, 4];
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < rgb.length; i++) {
      rgb[i] = (Math.floor(i / 3) % width) * 3; // horizontal ramp, identical rows
    }
    const encoder = new PngStreamEncoder(width, height);
    await encoder.writeRows(rgb);
    const blob = await encoder.finish();
    const decoded = await decodePng(blob);
    expect(decoded.rgb).toEqual(rgb);
    // Rows 1.. equal the row above: "Up" (2) turns them into zeros.
    expect(decoded.filters.slice(1)).toEqual([2, 2, 2]);
    expect(blob.size).toBeLessThan(rgb.length / 4);
  });

  it("rejects partial rows, extra rows and an unfinished image", async () => {
    const encoder = new PngStreamEncoder(4, 2);
    await expect(encoder.writeRows(new Uint8Array(5))).rejects.toThrow(RangeError);
    await encoder.writeRows(new Uint8Array(12));
    await expect(encoder.finish()).rejects.toThrow(/incomplete/);
    await expect(encoder.writeRows(new Uint8Array(24))).rejects.toThrow(RangeError);
    await encoder.abort();
  });

  it("rejects impossible sizes", () => {
    expect(() => new PngStreamEncoder(0, 10)).toThrow(RangeError);
    expect(() => new PngStreamEncoder(10.5, 10)).toThrow(RangeError);
  });
});
