// Streaming PNG encoder (8-bit RGB).
//
// The browser's own encoder, canvas.toBlob, needs the whole picture in one
// canvas: at 16K that is a 132-megapixel surface, beyond what several browsers
// allow and beyond the largest texture a default WebGPU device can hold. This
// encoder takes the image a few rows at a time instead, so memory use is one
// band of pixels plus the compressed output, whatever the image size.
//
// PNG in one paragraph: an 8-byte signature, then chunks (length, type, data,
// CRC-32 of type+data). IHDR describes the image; IDAT chunks carry one zlib
// stream; IEND closes the file. Inside the stream every row is preceded by a
// filter byte telling how the row was predicted from its neighbours, which is
// what makes smooth gradients compress. The zlib stream comes from the
// platform's CompressionStream; filtering, chunking and CRC are done here.

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const BYTES_PER_PIXEL = 3;

// Table-driven CRC-32 (the PNG polynomial, 0xEDB88320 reflected).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, seed = 0xffffffff): number {
  let c = seed;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return c;
}

// Builds one chunk: length, type, data, CRC over type + data.
function makeChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = type.charCodeAt(i);
  }
  chunk.set(data, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length)) ^ 0xffffffff;
  view.setUint32(8 + data.length, crc >>> 0);
  return chunk;
}

// Paeth predictor (PNG specification, section 9.4): whichever of left, above
// and upper-left is closest to left + above − upperLeft.
function paeth(left: number, above: number, upperLeft: number): number {
  const p = left + above - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - above);
  const pc = Math.abs(p - upperLeft);
  if (pa <= pb && pa <= pc) {
    return left;
  }
  return pb <= pc ? above : upperLeft;
}

// Filter types tried for each row. "None" and "Average" are left out: on
// continuous-tone images they almost never win, and each candidate costs a
// full pass over the row.
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_PAETH = 4;
const FILTERS = [FILTER_SUB, FILTER_UP, FILTER_PAETH];

export class PngStreamEncoder {
  private readonly height: number;
  private readonly rowBytes: number;

  private readonly compressor = new CompressionStream("deflate");
  private readonly writer: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>>;
  private readonly parts: Uint8Array<ArrayBuffer>[] = [];
  private readonly drained: Promise<void>;

  // Previous row, unfiltered: the Up and Paeth filters predict from it. All
  // zeros above the first row, as the specification says.
  private previousRow: Uint8Array;
  private readonly candidates: Uint8Array[];
  private rowsWritten = 0;

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError(`invalid image size ${width}x${height}`);
    }
    this.height = height;
    this.rowBytes = width * BYTES_PER_PIXEL;
    this.previousRow = new Uint8Array(this.rowBytes);
    this.candidates = FILTERS.map(() => new Uint8Array(this.rowBytes));

    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8; // bit depth
    header[9] = 2; // colour type: truecolour (RGB)
    header[10] = 0; // compression: deflate
    header[11] = 0; // filter method: adaptive
    header[12] = 0; // no interlacing
    this.parts.push(SIGNATURE, makeChunk("IHDR", header));

    this.writer = this.compressor.writable.getWriter();
    // Read the compressed side continuously: a stream nobody reads applies
    // back-pressure and the writes above it would never resolve.
    this.drained = this.drain();
  }

  // Appends rows from the top: tightly packed RGB, a whole number of rows.
  public async writeRows(rgb: Uint8Array): Promise<void> {
    if (rgb.length % this.rowBytes !== 0) {
      throw new RangeError("writeRows expects a whole number of RGB rows");
    }
    const rows = rgb.length / this.rowBytes;
    if (this.rowsWritten + rows > this.height) {
      throw new RangeError("more rows written than the image height");
    }

    const filtered = new Uint8Array(rows * (this.rowBytes + 1));
    for (let r = 0; r < rows; r++) {
      const row = rgb.subarray(r * this.rowBytes, (r + 1) * this.rowBytes);
      const filter = this.filterRow(row);
      const out = r * (this.rowBytes + 1);
      filtered[out] = FILTERS[filter];
      filtered.set(this.candidates[filter], out + 1);
      // Copy: the caller is free to reuse its buffer after this call.
      this.previousRow.set(row);
    }
    this.rowsWritten += rows;
    await this.writer.write(filtered);
  }

  // Closes the stream and returns the finished file.
  public async finish(): Promise<Blob> {
    if (this.rowsWritten !== this.height) {
      throw new Error(`PNG incomplete: ${this.rowsWritten} of ${this.height} rows written`);
    }
    await this.writer.close();
    await this.drained;
    this.parts.push(makeChunk("IEND", new Uint8Array(0)));
    return new Blob(this.parts, { type: "image/png" });
  }

  // Releases the compressor when an export is abandoned half-way.
  public async abort(): Promise<void> {
    await this.writer.abort().catch(() => undefined);
    await this.drained.catch(() => undefined);
  }

  // Fills this.candidates with the row under each filter and returns the index
  // of the one to keep. Heuristic of the PNG specification (section 12.8):
  // read the filtered bytes as signed and keep the smallest sum of magnitudes.
  private filterRow(row: Uint8Array): number {
    const [sub, up, paethOut] = this.candidates;
    const previous = this.previousRow;
    let sumSub = 0;
    let sumUp = 0;
    let sumPaeth = 0;

    for (let i = 0; i < this.rowBytes; i++) {
      const left = i >= BYTES_PER_PIXEL ? row[i - BYTES_PER_PIXEL] : 0;
      const above = previous[i];
      const upperLeft = i >= BYTES_PER_PIXEL ? previous[i - BYTES_PER_PIXEL] : 0;
      const value = row[i];

      const s = (value - left) & 0xff;
      const u = (value - above) & 0xff;
      const p = (value - paeth(left, above, upperLeft)) & 0xff;
      sub[i] = s;
      up[i] = u;
      paethOut[i] = p;
      sumSub += s < 128 ? s : 256 - s;
      sumUp += u < 128 ? u : 256 - u;
      sumPaeth += p < 128 ? p : 256 - p;
    }

    if (sumSub <= sumUp && sumSub <= sumPaeth) {
      return 0;
    }
    return sumUp <= sumPaeth ? 1 : 2;
  }

  // Wraps every block the compressor emits in its own IDAT chunk.
  private async drain(): Promise<void> {
    const reader = this.compressor.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      this.parts.push(makeChunk("IDAT", value));
    }
  }
}
