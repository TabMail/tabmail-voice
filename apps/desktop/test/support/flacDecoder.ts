// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** A test-only FLAC decoder (RFC 9639) for the subset `FLACEncoder` writes: one channel, 16 bits,
 * constant, verbatim and fixed-predictor subframes with 4-bit Rice parameters. It checks every
 * frame's CRC-8 and CRC-16, and throws on anything else, so a test fails rather than reading a
 * stream the encoder should not have written. */
export interface DecodedFLAC {
  sampleRate: number;
  minBlockSize: number;
  maxBlockSize: number;
  totalSamples: number;
  /** The samples as little-endian 16-bit PCM, as `Recording.pcm` holds them. */
  pcm: Uint8Array;
  frames: number;
}

export function decodeFLAC(bytes: Uint8Array): DecodedFLAC {
  const reader = new BitReader(bytes);
  if (reader.read(32) !== 0x664c6143) throw new Error("no fLaC marker");
  const last = reader.read(1);
  const type = reader.read(7);
  const length = reader.read(24);
  if (last !== 1 || type !== 0 || length !== 34) throw new Error("expected a single STREAMINFO block");
  const minBlockSize = reader.read(16);
  const maxBlockSize = reader.read(16);
  reader.read(24);
  reader.read(24);
  const sampleRate = reader.read(20);
  if (reader.read(3) !== 0) throw new Error("expected one channel");
  if (reader.read(5) !== 15) throw new Error("expected 16 bits per sample");
  const totalSamples = reader.read(4) * 2 ** 32 + reader.read(16) * 2 ** 16 + reader.read(16);
  for (let word = 0; word < 8; word += 1) reader.read(16);

  const samples: number[] = [];
  let frames = 0;
  while (reader.byteOffset < bytes.length) {
    const frameStart = reader.byteOffset;
    if (reader.read(14) !== 0b11111111111110 || reader.read(1) !== 0) throw new Error(`frame ${frames}: no sync code`);
    if (reader.read(1) !== 0) throw new Error("expected fixed block size");
    const sizeCode = reader.read(4);
    const rateCode = reader.read(4);
    if (reader.read(4) !== 0 || reader.read(3) !== 0b100 || reader.read(1) !== 0) throw new Error("expected mono 16-bit frames");
    const frameNumber = readCodedNumber(reader);
    if (frameNumber !== frames) throw new Error(`frame ${frames} numbered ${frameNumber}`);
    const blockSize = sizeCode === 6 ? reader.read(8) + 1 : sizeCode === 7 ? reader.read(16) + 1 : sizeCode === 1 ? 192 : sizeCode <= 5 ? 576 * 2 ** (sizeCode - 2) : 256 * 2 ** (sizeCode - 8);
    const frameRate = rateCode === 12 ? reader.read(8) * 1000 : rateCode === 13 ? reader.read(16) : rateCode === 14 ? reader.read(16) * 10 : rateCode === 0 ? sampleRate : standardRates[rateCode];
    if (frameRate !== sampleRate) throw new Error(`frame ${frames}: rate ${frameRate}, STREAMINFO ${sampleRate}`);
    const headerCRC = crc(bytes.subarray(frameStart, reader.byteOffset), 0x07, 8);
    if (reader.read(8) !== headerCRC) throw new Error(`frame ${frames}: header CRC-8 mismatch`);

    readSubframe(reader, blockSize, samples);
    reader.alignToByte();
    const frameCRC = crc(bytes.subarray(frameStart, reader.byteOffset), 0x8005, 16);
    if (reader.read(16) !== frameCRC) throw new Error(`frame ${frames}: CRC-16 mismatch`);
    frames += 1;
  }
  if (samples.length !== totalSamples) throw new Error(`STREAMINFO says ${totalSamples} samples, frames hold ${samples.length}`);
  const pcm = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return { sampleRate, minBlockSize, maxBlockSize, totalSamples, pcm, frames };
}

const standardRates = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];

function readSubframe(reader: BitReader, blockSize: number, out: number[]): void {
  if (reader.read(1) !== 0) throw new Error("subframe padding bit set");
  const type = reader.read(6);
  if (reader.read(1) !== 0) throw new Error("wasted bits are never written");
  if (type === 0) {
    const value = signed(reader.read(16), 16);
    for (let index = 0; index < blockSize; index += 1) out.push(value);
    return;
  }
  if (type === 1) {
    for (let index = 0; index < blockSize; index += 1) out.push(signed(reader.read(16), 16));
    return;
  }
  if (type < 8 || type > 12) throw new Error(`unexpected subframe type ${type}`);
  const order = type - 8;
  const block: number[] = [];
  for (let index = 0; index < order; index += 1) block.push(signed(reader.read(16), 16));
  if (reader.read(2) !== 0) throw new Error("expected 4-bit Rice parameters");
  const partitionOrder = reader.read(4);
  const partitions = 2 ** partitionOrder;
  const residual: number[] = [];
  for (let partition = 0; partition < partitions; partition += 1) {
    const parameter = reader.read(4);
    if (parameter === 15) throw new Error("escape code is never written");
    const count = blockSize / partitions - (partition === 0 ? order : 0);
    for (let index = 0; index < count; index += 1) {
      let quotient = 0;
      while (reader.read(1) === 0) quotient += 1;
      const value = quotient * 2 ** parameter + (parameter > 0 ? reader.read(parameter) : 0);
      residual.push(value % 2 === 0 ? value / 2 : -(value + 1) / 2);
    }
  }
  const coefficients = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]][order]!;
  for (const error of residual) {
    const i = block.length;
    let prediction = 0;
    coefficients.forEach((coefficient, lag) => {
      prediction += coefficient * block[i - 1 - lag]!;
    });
    block.push(prediction + error);
  }
  if (block.length !== blockSize) throw new Error(`subframe decoded ${block.length} of ${blockSize} samples`);
  out.push(...block);
}

function readCodedNumber(reader: BitReader): number {
  const first = reader.read(8);
  if (first < 0x80) return first;
  let continuation = 0;
  while (first & (0x40 >> continuation)) continuation += 1;
  let value = first & (0x3f >> continuation);
  for (let index = 0; index < continuation; index += 1) {
    const next = reader.read(8);
    if ((next & 0xc0) !== 0x80) throw new Error("bad coded number");
    value = value * 64 + (next & 0x3f);
  }
  return value;
}

function signed(value: number, bits: number): number {
  return value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
}

/** A straightforward bitwise CRC, independent of the encoder's table-driven one. */
function crc(bytes: Uint8Array, polynomial: number, width: number): number {
  const top = 2 ** (width - 1);
  const mask = 2 ** width - 1;
  let value = 0;
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      const incoming = (byte >> bit) & 1;
      const feedback = (value & top ? 1 : 0) ^ incoming;
      value = (value * 2) & mask;
      if (feedback) value ^= polynomial;
    }
  }
  return value;
}

class BitReader {
  private position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get byteOffset(): number {
    return Math.ceil(this.position / 8);
  }

  read(bits: number): number {
    let value = 0;
    for (let index = 0; index < bits; index += 1) {
      const byte = this.bytes[this.position >> 3];
      if (byte === undefined) throw new Error("read past the end of the stream");
      value = value * 2 + ((byte >> (7 - (this.position & 7))) & 1);
      this.position += 1;
    }
    return value;
  }

  alignToByte(): void {
    this.position = Math.ceil(this.position / 8) * 8;
  }
}
