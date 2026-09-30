// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "./config.js";

/** Encodes 16-bit mono samples as FLAC (RFC 9639): lossless, about half the size of WAV for speech,
 * so the upload is shorter. Each full frame is encoded as soon as its samples are appended; the whole
 * recording takes about 1.4 ms per second of audio. Each frame's subframe is the smallest of
 * constant (digital silence), verbatim and the fixed predictors of order 0–4 with Rice-coded
 * residuals. */
export class FLACEncoder {
  private readonly frames = new BitWriter(config.flacBlockSize * 2);
  private readonly block = new Int32Array(config.flacBlockSize);
  private buffered = 0;
  private frameNumber = 0;
  private samples = 0;

  constructor(readonly sampleRate: number) {}

  append(samples: Int16Array): void {
    for (const sample of samples) {
      this.block[this.buffered] = sample;
      this.buffered += 1;
      if (this.buffered === this.block.length) this.flush();
    }
  }

  /** The whole stream: the header, then every frame. */
  finish(): Uint8Array {
    this.flush();
    const rate = Math.trunc(this.sampleRate);
    const blockSize = Math.min(config.flacBlockSize, Math.max(this.samples, 1));
    const header = new BitWriter(streamHeaderBytes);
    header.bytes("fLaC");
    // The last (and only) metadata block: STREAMINFO.
    header.write(1, 1);
    header.write(0, 7);
    header.write(streamInfoBytes, 24);
    header.write(blockSize, 16);
    header.write(blockSize, 16);
    header.write(0, 24); // smallest and largest frame: unknown
    header.write(0, 24);
    header.write(rate, 20);
    header.write(0, 3); // one channel
    header.write(bitsPerSample - 1, 5);
    header.write(Math.floor(this.samples / 2 ** 32), 4); // 36-bit sample count
    header.write(Math.floor(this.samples / 2 ** 16) % 2 ** 16, 16);
    header.write(this.samples % 2 ** 16, 16);
    for (let word = 0; word < 8; word += 1) header.write(0, 16); // no MD5 signature
    const head = header.finish();
    const frames = this.frames.finish();
    const stream = new Uint8Array(head.length + frames.length);
    stream.set(head);
    stream.set(frames, head.length);
    return stream;
  }

  private flush(): void {
    if (this.buffered === 0) return;
    writeFrame(this.frames, this.block.subarray(0, this.buffered), this.frameNumber, Math.trunc(this.sampleRate));
    this.samples += this.buffered;
    this.frameNumber += 1;
    this.buffered = 0;
  }
}

const bitsPerSample = 16;
const streamInfoBytes = 34;
/** "fLaC", the metadata block header and STREAMINFO. */
const streamHeaderBytes = 4 + 4 + streamInfoBytes;
/** The 4-bit Rice parameter's largest value; 15 is the escape code, never written here. */
const maxRiceParameter = 14;
const fixedPredictorOrders = 4;

/** The frame header's block size codes for the sizes it names outright (RFC 9639 §9.1.1). */
const blockSizeCodes = new Map([
  [192, 1], [576, 2], [1152, 3], [2304, 4], [4608, 5],
  [256, 8], [512, 9], [1024, 10], [2048, 11], [4096, 12], [8192, 13], [16384, 14], [32768, 15],
]);
/** The frame header's sample rate codes for the rates it names outright (RFC 9639 §9.1.2). */
const sampleRateCodes = new Map([
  [88200, 1], [176400, 2], [192000, 3], [8000, 4], [16000, 5], [22050, 6],
  [24000, 7], [32000, 8], [44100, 9], [48000, 10], [96000, 11],
]);

function writeFrame(writer: BitWriter, block: Int32Array, frame: number, rate: number): void {
  const frameStart = writer.byteLength;
  writer.write(0b11111111111110, 14);
  writer.write(0, 1);
  writer.write(0, 1); // fixed block size
  const sizeCode = blockSizeCodes.get(block.length) ?? (block.length <= 256 ? 6 : 7);
  writer.write(sizeCode, 4);
  let rateCode = sampleRateCodes.get(rate);
  let rateBits = 0;
  if (rateCode === undefined) {
    if (rate % 1000 === 0 && rate / 1000 < 256) [rateCode, rateBits] = [12, 8];
    else if (rate < 65536) [rateCode, rateBits] = [13, 16];
    else if (rate % 10 === 0 && rate / 10 < 65536) [rateCode, rateBits] = [14, 16];
    else rateCode = 0; // STREAMINFO's
  }
  writer.write(rateCode, 4);
  writer.write(0, 4); // mono
  writer.write(0b100, 3); // 16 bits per sample
  writer.write(0, 1);
  writeCodedNumber(writer, frame);
  if (sizeCode === 6) writer.write(block.length - 1, 8);
  if (sizeCode === 7) writer.write(block.length - 1, 16);
  if (rateBits > 0) writer.write(rateCode === 12 ? rate / 1000 : rateCode === 14 ? rate / 10 : rate, rateBits);
  writer.write(writer.crc8(frameStart), 8);
  writeSubframe(writer, block);
  writer.alignToByte();
  writer.write(writer.crc16(frameStart), 16);
}

/** The frame number in the UTF-8-like coding of RFC 9639 §9.1.5. */
function writeCodedNumber(writer: BitWriter, value: number): void {
  if (value < 0x80) {
    writer.write(value, 8);
    return;
  }
  let continuation = 1;
  while (value >= 2 ** (6 * continuation + 6 - continuation)) continuation += 1;
  writer.write(((0xff << (7 - continuation)) & 0xff) | Math.floor(value / 2 ** (6 * continuation)), 8);
  for (let index = continuation - 1; index >= 0; index -= 1) writer.write(0x80 | (Math.floor(value / 2 ** (6 * index)) & 0x3f), 8);
}

function writeSubframe(writer: BitWriter, block: Int32Array): void {
  if (block.every((sample) => sample === block[0])) {
    writer.write(0, 8); // constant
    writer.write(block[0]! & 0xffff, bitsPerSample);
    return;
  }
  const verbatimBits = block.length * bitsPerSample;
  let best: { order: number; residual: Int32Array; partitions: RicePartitions } | null = null;
  let bestBits = verbatimBits;
  for (let order = 0; order <= fixedPredictorOrders && order < block.length; order += 1) {
    const residual = fixedResidual(block, order);
    const partitions = ricePartitions(residual, block.length, order);
    const bits = order * bitsPerSample + partitions.bits;
    if (bits < bestBits) [best, bestBits] = [{ order, residual, partitions }, bits];
  }
  if (best === null) {
    writer.write(0b00000010, 8); // verbatim
    for (const sample of block) writer.write(sample & 0xffff, bitsPerSample);
    return;
  }
  writer.write(0b00010000 | (best.order << 1), 8); // fixed predictor of this order
  for (let index = 0; index < best.order; index += 1) writer.write(block[index]! & 0xffff, bitsPerSample);
  writer.write(0, 2); // Rice, 4-bit parameters
  writer.write(best.partitions.order, 4);
  const count = 1 << best.partitions.order;
  const perPartition = block.length >> best.partitions.order;
  let position = 0;
  for (let partition = 0; partition < count; partition += 1) {
    const parameter = best.partitions.parameters[partition]!;
    writer.write(parameter, 4);
    const end = (partition + 1) * perPartition - best.order;
    for (; position < end; position += 1) writer.rice(zigzag(best.residual[position]!), parameter);
  }
}

/** The residual of the fixed predictor of `order` (RFC 9639 §9.2.5): `block.length - order` values. */
function fixedResidual(x: Int32Array, order: number): Int32Array {
  const residual = new Int32Array(x.length - order);
  let i = order;
  if (order === 0) residual.set(x);
  else if (order === 1) for (; i < x.length; i += 1) residual[i - 1] = x[i]! - x[i - 1]!;
  else if (order === 2) for (; i < x.length; i += 1) residual[i - 2] = x[i]! - 2 * x[i - 1]! + x[i - 2]!;
  else if (order === 3) for (; i < x.length; i += 1) residual[i - 3] = x[i]! - 3 * x[i - 1]! + 3 * x[i - 2]! - x[i - 3]!;
  else for (; i < x.length; i += 1) residual[i - 4] = x[i]! - 4 * x[i - 1]! + 6 * x[i - 2]! - 4 * x[i - 3]! + x[i - 4]!;
  return residual;
}

function zigzag(value: number): number {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

interface RicePartitions {
  order: number;
  parameters: number[];
  /** The residual section's estimated size, its method and order fields included. */
  bits: number;
}

/** The partition order and per-partition Rice parameters that code `residual` smallest, estimated
 * from each partition's sum as libFLAC does. */
function ricePartitions(residual: Int32Array, blockLength: number, order: number): RicePartitions {
  let maxOrder = 0;
  while (
    maxOrder < config.flacMaxPartitionOrder &&
    blockLength % (1 << (maxOrder + 1)) === 0 &&
    blockLength >> (maxOrder + 1) > order
  ) maxOrder += 1;
  // Sums of the finest partitions, merged pairwise for each coarser order.
  const finest = 1 << maxOrder;
  const finestLength = blockLength >> maxOrder;
  let sums = new Array<number>(finest).fill(0);
  let lengths = new Array<number>(finest).fill(finestLength);
  lengths[0]! -= order;
  for (let index = 0; index < residual.length; index += 1) sums[Math.floor((index + order) / finestLength)]! += zigzag(residual[index]!);
  let best: RicePartitions | null = null;
  for (let partitionOrder = maxOrder; partitionOrder >= 0; partitionOrder -= 1) {
    const parameters: number[] = [];
    let bits = 2 + 4;
    for (let partition = 0; partition < sums.length; partition += 1) {
      const { parameter, bits: partitionBits } = riceParameter(sums[partition]!, lengths[partition]!);
      parameters.push(parameter);
      bits += 4 + partitionBits;
    }
    if (best === null || bits < best.bits) best = { order: partitionOrder, parameters, bits };
    if (partitionOrder > 0) {
      sums = sums.filter((_, index) => index % 2 === 0).map((sum, index) => sum + sums[index * 2 + 1]!);
      lengths = lengths.filter((_, index) => index % 2 === 0).map((length, index) => length + lengths[index * 2 + 1]!);
    }
  }
  return best!;
}

function riceParameter(sum: number, length: number): { parameter: number; bits: number } {
  let parameter = 0;
  let bits = length + sum;
  for (let candidate = 1; candidate <= maxRiceParameter; candidate += 1) {
    const candidateBits = length * (candidate + 1) + Math.floor(sum / 2 ** candidate);
    if (candidateBits < bits) [parameter, bits] = [candidate, candidateBits];
  }
  return { parameter, bits };
}

const crc8Table = crcTable(0x07, 8);
const crc16Table = crcTable(0x8005, 16);

function crcTable(polynomial: number, width: number): Uint16Array {
  const top = 1 << (width - 1);
  const mask = (1 << width) - 1;
  const table = new Uint16Array(256);
  for (let byte = 0; byte < 256; byte += 1) {
    let crc = byte << (width - 8);
    for (let bit = 0; bit < 8; bit += 1) crc = crc & top ? ((crc << 1) ^ polynomial) & mask : (crc << 1) & mask;
    table[byte] = crc;
  }
  return table;
}

/** Big-endian bit packing into a growing buffer. */
class BitWriter {
  private buffer: Uint8Array;
  private length = 0;
  private pending = 0;
  private pendingBits = 0;

  constructor(capacity: number) {
    this.buffer = new Uint8Array(Math.max(64, Math.ceil(capacity)));
  }

  get byteLength(): number {
    return this.length;
  }

  bytes(text: string): void {
    for (let index = 0; index < text.length; index += 1) this.write(text.charCodeAt(index), 8);
  }

  /** `value`'s low `bits` bits (at most 24), most significant first. */
  write(value: number, bits: number): void {
    this.pending = (this.pending << bits) | (value & ((1 << bits) - 1));
    this.pendingBits += bits;
    while (this.pendingBits >= 8) {
      this.pendingBits -= 8;
      this.push((this.pending >>> this.pendingBits) & 0xff);
    }
    this.pending &= (1 << this.pendingBits) - 1;
  }

  /** `value` Rice-coded with `parameter`: the quotient in unary (zeros, then a one), then the low bits. */
  rice(value: number, parameter: number): void {
    let quotient = Math.floor(value / 2 ** parameter);
    while (quotient >= 16) {
      this.write(0, 16);
      quotient -= 16;
    }
    this.write(1, quotient + 1);
    if (parameter > 0) this.write(value & ((1 << parameter) - 1), parameter);
  }

  alignToByte(): void {
    if (this.pendingBits > 0) this.write(0, 8 - this.pendingBits);
  }

  crc8(from: number): number {
    let crc = 0;
    for (let index = from; index < this.length; index += 1) crc = crc8Table[crc ^ this.buffer[index]!]!;
    return crc;
  }

  crc16(from: number): number {
    let crc = 0;
    for (let index = from; index < this.length; index += 1) crc = ((crc << 8) & 0xffff) ^ crc16Table[(crc >> 8) ^ this.buffer[index]!]!;
    return crc;
  }

  finish(): Uint8Array {
    this.alignToByte();
    return this.buffer.slice(0, this.length);
  }

  private push(byte: number): void {
    if (this.length === this.buffer.length) {
      const grown = new Uint8Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.length] = byte;
    this.length += 1;
  }
}
