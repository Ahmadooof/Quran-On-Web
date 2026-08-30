/**
 * Just enough MPEG audio to measure how loud a file is, frame by frame.
 *
 * Decoding the samples would mean a full Layer III decoder — Huffman tables,
 * the IMDCT, the polyphase bank — for a number we can read straight off the
 * frame. Every granule states global_gain, the exponent of the quantiser step
 * it was coded with, which the encoder sets from how large the granule's
 * samples are: it is the signal's level in log scale, already measured, eight
 * bits into the side info.
 *
 * part2_3_length — the bits spent on the granule — looks like the same thing
 * and is not. This surah is 64 kbps constant, which for 22 kHz stereo is thin
 * enough that the encoder spends its whole budget on almost every frame; the
 * count then reports the budget rather than the sound. global_gain has no
 * budget to saturate.
 *
 * One reading per frame: 576 samples at 22050 Hz, so 26 ms — finer than any
 * pause worth finding.
 */
'use strict';

/* kbps by bitrate_index, MPEG1 then MPEG2/2.5, Layer III */
var BITRATE = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
var SAMPLERATE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** A frame header, or null where these four bytes are not one. */
function header(buf, o) {
  if (o + 4 > buf.length) return null;
  if (buf[o] !== 0xFF || (buf[o + 1] & 0xE0) !== 0xE0) return null;

  var verBits = (buf[o + 1] >> 3) & 3;          // 3 MPEG1, 2 MPEG2, 0 MPEG2.5
  var layer   = (buf[o + 1] >> 1) & 3;          // 1 is Layer III
  if (verBits === 1 || layer !== 1) return null;

  var brIndex = (buf[o + 2] >> 4) & 15;
  var srIndex = (buf[o + 2] >> 2) & 3;
  if (brIndex === 0 || brIndex === 15 || srIndex === 3) return null;

  var lsf  = verBits !== 3;                     // MPEG2 and 2.5 halve everything
  var rate = BITRATE[lsf ? 2 : 1][brIndex] * 1000;
  var sr   = SAMPLERATE[verBits][srIndex];
  if (!rate) return null;

  var mode = (buf[o + 3] >> 6) & 3;             // 3 is single channel
  var channels = mode === 3 ? 1 : 2;
  var samples  = lsf ? 576 : 1152;
  var pad = (buf[o + 2] >> 1) & 1;

  return {
    lsf: lsf,
    channels: channels,
    sampleRate: sr,
    samples: samples,
    crc: !(buf[o + 1] & 1),                     // the bit is 0 when a CRC follows
    length: Math.floor(samples / 8 * rate / sr) + pad,
  };
}

/* One granule of one channel, whole: part2_3_length, big_values, global_gain,
   scalefac_compress and the rest. window_switching_flag picks between two
   branches of the same width, so a granule is always this long — which is why
   the fields after it can be reached by counting rather than by parsing.
   LSF spends five more bits on scalefac_compress and none on preflag. */
function granuleBits(lsf) {
  return lsf ? 63 : 59;
}

function readBits(buf, at, bitOffset, count) {
  var v = 0;
  for (var i = 0; i < count; i++) {
    var b = bitOffset + i;
    v = (v << 1) | ((buf[at + (b >> 3)] >> (7 - (b & 7))) & 1);
  }
  return v;
}

/**
 * The loudest granule in one frame, as its global_gain.
 *
 * Side info begins after the header and the CRC, if any: main_data_begin
 * (8 bits for LSF, 9 otherwise), then the private bits, then — for MPEG1 only
 * — one scfsi nibble per channel, and then the granules. Within a granule
 * global_gain follows part2_3_length (12 bits) and big_values (9).
 *
 * The loudest rather than the mean: a stereo pair of a single voice holds the
 * same recitation twice, and one channel dipping is the room, not a pause.
 */
function frameGain(buf, o, h) {
  var at = o + 4 + (h.crc ? 2 : 0);
  var bit = h.lsf ? 8 : 9;
  bit += h.lsf ? (h.channels === 1 ? 1 : 2) : (h.channels === 1 ? 5 : 3);
  if (!h.lsf) bit += 4 * h.channels;

  var step = granuleBits(h.lsf);
  var grans = h.lsf ? 1 : 2;
  var loudest = 0;
  for (var g = 0; g < grans; g++) {
    for (var c = 0; c < h.channels; c++) {
      var gain = readBits(buf, at, bit + 21, 8);   // past part2_3_length and big_values
      if (gain > loudest) loudest = gain;
      bit += step;
    }
  }
  return loudest;
}

/** Where the audio starts: past an ID3v2 tag, at the first of a run of frames
    that chain head to tail. A lone 0xFFE byte pattern turns up inside album
    art often enough that one sync proves nothing. */
function firstFrame(buf) {
  var from = 0;
  if (buf.toString('latin1', 0, 3) === 'ID3') {
    from = 10 + (((buf[6] & 127) << 21) | ((buf[7] & 127) << 14) |
                 ((buf[8] & 127) << 7) | (buf[9] & 127));
  }
  for (var o = from; o < buf.length - 4; o++) {
    var h = header(buf, o), p = o, ok = !!h;
    for (var k = 0; ok && k < 12; k++) {
      var q = header(buf, p);
      if (!q) ok = false; else p += q.length;
    }
    if (ok) return o;
  }
  return -1;
}

/**
 * The whole file as one loudness reading per frame.
 * Returns { hop, rate, channels, duration, gain } — gain[i] covering the
 * i-th frame, which begins at i * hop seconds.
 */
function envelope(buf) {
  var o = firstFrame(buf);
  if (o < 0) throw new Error('no MPEG frames found');

  var first = header(buf, o);
  var gain = [], time = 0;

  while (o < buf.length - 4) {
    var h = header(buf, o);
    /* A frame that does not parse is a damaged one, not the end of the file:
       step a byte and look again rather than dropping the rest of the surah. */
    if (!h) { o++; continue; }
    gain.push(frameGain(buf, o, h));
    time += h.samples / h.sampleRate;
    o += h.length;
  }

  return {
    hop: first.samples / first.sampleRate,
    rate: first.sampleRate,
    channels: first.channels,
    duration: time,
    gain: Float64Array.from(gain),
  };
}

module.exports = { envelope: envelope, header: header, firstFrame: firstFrame };
