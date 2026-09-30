// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Wraps 16-bit mono PCM in a canonical 44-byte RIFF/WAVE header. */
export const wavHeaderSize = 44;
const bitsPerSample = 16;
const channels = 1;
const pcmFormatTag = 1;
const fmtChunkSize = 16;

export function encodeWAV(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const rate = Math.trunc(sampleRate);
  const blockAlign = (channels * bitsPerSample) / 8;
  const wav = new Uint8Array(wavHeaderSize + pcm.length);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) wav[offset + index] = text.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, wavHeaderSize - 8 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, fmtChunkSize, true);
  view.setUint16(20, pcmFormatTag, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, wavHeaderSize);
  return wav;
}
