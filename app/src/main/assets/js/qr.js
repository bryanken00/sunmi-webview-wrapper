/**
 * QR encoding, byte mode.
 *
 * Label mode draws the whole sticker as one bitmap so its height is exact, and
 * a QR drawn by the printer cannot be part of that bitmap — so the symbol has
 * to be generated here. Implements ISO/IEC 18004 far enough for byte-mode
 * payloads at any version and error-correction level, which is everything a
 * label needs.
 *
 * Verified module-for-module against Project Nayuki's qrcodegen across every
 * version and level; see the checks in the repo's scratch tests.
 */
(function (global) {
  "use strict";

  var LEVEL_NAMES = ['L', 'M', 'Q', 'H'];

  /** Format-info bits per level, from the spec — not the ordinal. */
  var ECC = {
    L: { ordinal: 0, formatBits: 1 },
    M: { ordinal: 1, formatBits: 0 },
    Q: { ordinal: 2, formatBits: 3 },
    H: { ordinal: 3, formatBits: 2 },
  };

  /** ECC codewords per block, indexed [level ordinal][version]. */
  var ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28,
      28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26,
      26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26,
      30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26,
      28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];

  /** Number of ECC blocks, indexed [level ordinal][version]. */
  var NUM_ECC_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7,
      8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14,
      16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21,
      20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25,
      25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];

  /* ── GF(256) arithmetic, primitive polynomial 0x11D ────────────────────── */

  function gfMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i -= 1) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  /** Coefficients of the divisor polynomial for `degree` ECC codewords. */
  function reedSolomonDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i += 1) result.push(0);
    result.push(1);

    // Multiply by (x - r^i) for each i, where r = 0x02 is a generator of GF(256).
    var root = 1;
    for (var d = 0; d < degree; d += 1) {
      for (var j = 0; j < result.length; j += 1) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 0x02);
    }
    return result;
  }

  function reedSolomonRemainder(data, divisor) {
    var result = [];
    for (var i = 0; i < divisor.length; i += 1) result.push(0);

    for (var d = 0; d < data.length; d += 1) {
      var factor = data[d] ^ result.shift();
      result.push(0);
      for (var j = 0; j < divisor.length; j += 1) {
        result[j] ^= gfMultiply(divisor[j], factor);
      }
    }
    return result;
  }

  /* ── Capacity ──────────────────────────────────────────────────────────── */

  /** Data modules available before ECC, for a version. */
  function rawDataModules(version) {
    var result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      var numAlign = Math.floor(version / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  }

  function dataCodewords(version, ecc) {
    return (
      Math.floor(rawDataModules(version) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version] * NUM_ECC_BLOCKS[ecc.ordinal][version]
    );
  }

  function alignmentPositions(version) {
    if (version === 1) return [];

    var numAlign = Math.floor(version / 7) + 2;
    var size = version * 4 + 17;
    // Version 32 is the one case the general formula gets wrong.
    var step = version === 32
      ? 26
      : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;

    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  /* ── Bit stream ────────────────────────────────────────────────────────── */

  function appendBits(value, length, bits) {
    for (var i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  }

  /** UTF-8 bytes of a string, without depending on TextEncoder. */
  function toUtf8(text) {
    var encoded = unescape(encodeURIComponent(String(text)));
    var bytes = [];
    for (var i = 0; i < encoded.length; i += 1) bytes.push(encoded.charCodeAt(i) & 0xff);
    return bytes;
  }

  /* ── Matrix ────────────────────────────────────────────────────────────── */

  function makeGrid(size, value) {
    var grid = [];
    for (var y = 0; y < size; y += 1) {
      var row = [];
      for (var x = 0; x < size; x += 1) row.push(value);
      grid.push(row);
    }
    return grid;
  }

  function Symbol_(version, ecc) {
    this.version = version;
    this.ecc = ecc;
    this.size = version * 4 + 17;
    this.modules = makeGrid(this.size, false);
    // Function patterns must not be masked, and must not receive data.
    this.reserved = makeGrid(this.size, false);
  }

  Symbol_.prototype.setFunction = function (x, y, dark) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  };

  Symbol_.prototype.drawFinder = function (cx, cy) {
    for (var dy = -4; dy <= 4; dy += 1) {
      for (var dx = -4; dx <= 4; dx += 1) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy)); // Chebyshev ring index
        this.setFunction(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };

  Symbol_.prototype.drawAlignment = function (cx, cy) {
    for (var dy = -2; dy <= 2; dy += 1) {
      for (var dx = -2; dx <= 2; dx += 1) {
        this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  Symbol_.prototype.drawFunctionPatterns = function () {
    var size = this.size;
    var i;

    // Timing patterns.
    for (i = 0; i < size; i += 1) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }

    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);

    var positions = alignmentPositions(this.version);
    for (i = 0; i < positions.length; i += 1) {
      for (var j = 0; j < positions.length; j += 1) {
        // The three corners are taken by finder patterns.
        var corner =
          (i === 0 && j === 0) ||
          (i === 0 && j === positions.length - 1) ||
          (i === positions.length - 1 && j === 0);
        if (!corner) this.drawAlignment(positions[i], positions[j]);
      }
    }

    // Reserve format and version areas; the real bits are drawn after masking.
    this.drawFormatBits(0);
    this.drawVersionBits();
  };

  Symbol_.prototype.drawFormatBits = function (mask) {
    var data = (this.ecc.formatBits << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;

    var i2;
    // Top-left copy.
    for (i2 = 0; i2 <= 5; i2 += 1) this.setFunction(8, i2, getBit(bits, i2));
    this.setFunction(8, 7, getBit(bits, 6));
    this.setFunction(8, 8, getBit(bits, 7));
    this.setFunction(7, 8, getBit(bits, 8));
    for (i2 = 9; i2 < 15; i2 += 1) this.setFunction(14 - i2, 8, getBit(bits, i2));

    // Second copy, split across the other two finders.
    var size = this.size;
    for (i2 = 0; i2 < 8; i2 += 1) this.setFunction(size - 1 - i2, 8, getBit(bits, i2));
    for (i2 = 8; i2 < 15; i2 += 1) this.setFunction(8, size - 15 + i2, getBit(bits, i2));
    this.setFunction(8, size - 8, true); // the always-dark module
  };

  Symbol_.prototype.drawVersionBits = function () {
    if (this.version < 7) return;

    var rem = this.version;
    for (var i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    var bits = (this.version << 12) | rem;

    for (var j = 0; j < 18; j += 1) {
      var bit = getBit(bits, j);
      var a = this.size - 11 + (j % 3);
      var b = Math.floor(j / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  };

  function getBit(x, i) {
    return ((x >>> i) & 1) !== 0;
  }

  /** Lay the interleaved codewords along the zigzag, skipping function modules. */
  Symbol_.prototype.drawCodewords = function (data) {
    var i = 0;
    var size = this.size;

    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // the vertical timing pattern column is skipped

      for (var vert = 0; vert < size; vert += 1) {
        for (var j = 0; j < 2; j += 1) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;

          if (!this.reserved[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i += 1;
          }
          // Any remaining modules stay light, which is what the spec requires.
        }
      }
    }
  };

  Symbol_.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y += 1) {
      for (var x = 0; x < this.size; x += 1) {
        if (this.reserved[y][x]) continue;

        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }

        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  };

  /** The spec's four penalty rules; the lowest total wins. */
  Symbol_.prototype.penalty = function () {
    var size = this.size;
    var result = 0;
    var x;
    var y;

    // Rules 1 and 3, scanned in both directions.
    for (y = 0; y < size; y += 1) {
      var runColor = false;
      var runLength = 0;
      var runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (x = 0; x < size; x += 1) {
        if (this.modules[y][x] === runColor) {
          runLength += 1;
          if (runLength === 5) result += 3;
          else if (runLength > 5) result += 1;
        } else {
          this.pushRun(runLength, runHistory);
          if (!runColor) result += this.finderPenalty(runHistory) * 40;
          runColor = this.modules[y][x];
          runLength = 1;
        }
      }
      result += this.terminateRun(runColor, runLength, runHistory) * 40;
    }

    for (x = 0; x < size; x += 1) {
      var runColorV = false;
      var runLengthV = 0;
      var runHistoryV = [0, 0, 0, 0, 0, 0, 0];
      for (y = 0; y < size; y += 1) {
        if (this.modules[y][x] === runColorV) {
          runLengthV += 1;
          if (runLengthV === 5) result += 3;
          else if (runLengthV > 5) result += 1;
        } else {
          this.pushRun(runLengthV, runHistoryV);
          if (!runColorV) result += this.finderPenalty(runHistoryV) * 40;
          runColorV = this.modules[y][x];
          runLengthV = 1;
        }
      }
      result += this.terminateRun(runColorV, runLengthV, runHistoryV) * 40;
    }

    // Rule 2: 2x2 blocks of one colour.
    for (y = 0; y < size - 1; y += 1) {
      for (x = 0; x < size - 1; x += 1) {
        var c = this.modules[y][x];
        if (c === this.modules[y][x + 1] &&
            c === this.modules[y + 1][x] &&
            c === this.modules[y + 1][x + 1]) {
          result += 3;
        }
      }
    }

    // Rule 4: deviation of dark module share from 50%.
    var dark = 0;
    for (y = 0; y < size; y += 1) {
      for (x = 0; x < size; x += 1) if (this.modules[y][x]) dark += 1;
    }
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;

    return result;
  };

  Symbol_.prototype.pushRun = function (length, history) {
    // The very first run is preceded by the light quiet zone, which counts
    // towards it — the border widens the run, it is not a history entry.
    if (history[0] === 0) length += this.size;
    history.pop();
    history.unshift(length);
  };

  /** Count 1:1:3:1:1 finder-lookalike patterns ending at the current run. */
  Symbol_.prototype.finderPenalty = function (history) {
    var n = history[1];
    var core =
      n > 0 &&
      history[2] === n &&
      history[3] === n * 3 &&
      history[4] === n &&
      history[5] === n;
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
      (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
  };

  Symbol_.prototype.terminateRun = function (color, length, history) {
    if (color) {
      this.pushRun(length, history);
      length = 0;
    }
    length += this.size; // the light border past the edge
    this.pushRun(length, history);
    return this.finderPenalty(history);
  };

  /* ── Encode ────────────────────────────────────────────────────────────── */

  /**
   * @param {string} text - payload, encoded as UTF-8 bytes
   * @param {string} [level] - "L", "M", "Q" or "H" (default "M")
   * @param {number} [forceMask] - pin the mask to 0..7 instead of scoring them
   * @returns {{size: number, modules: boolean[][], version: number, level: string}}
   */
  function encode(text, level, forceMask) {
    var ecc = ECC[level] || ECC.M;
    var bytes = toUtf8(text);

    var fits = function (v, e) {
      return 4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v, e) * 8;
    };

    // Smallest version the payload fits in, at the requested level.
    var version = 0;
    for (var v = 1; v <= 40; v += 1) {
      if (fits(v, ecc)) {
        version = v;
        break;
      }
    }
    if (!version) throw new Error('Too much data for a QR code');

    // Spend any slack in that version on stronger error correction rather than
    // leaving it as padding - the symbol is the same size either way, and a
    // sticker that gets scuffed or peeled still scans. The requested level is
    // a floor, which is also what qrcodegen does by default.
    var ORDER = [ECC.L, ECC.M, ECC.Q, ECC.H];
    for (var b = ORDER.length - 1; b >= 0; b -= 1) {
      if (ORDER[b].ordinal > ecc.ordinal && fits(version, ORDER[b])) {
        ecc = ORDER[b];
        break;
      }
    }

    var bits = [];
    appendBits(0x4, 4, bits); // byte mode
    appendBits(bytes.length, version < 10 ? 8 : 16, bits);
    for (var b = 0; b < bytes.length; b += 1) appendBits(bytes[b], 8, bits);

    var capacityBits = dataCodewords(version, ecc) * 8;
    appendBits(0, Math.min(4, capacityBits - bits.length), bits); // terminator
    appendBits(0, (8 - (bits.length % 8)) % 8, bits); // pad to a whole codeword
    // Alternating pad codewords, per the spec.
    for (var pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
      appendBits(pad, 8, bits);
    }

    var codewords = [];
    for (var i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (var j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
      codewords.push(byte);
    }

    var interleaved = interleave(codewords, version, ecc);

    var symbol = new Symbol_(version, ecc);
    symbol.drawFunctionPatterns();
    symbol.drawCodewords(interleaved);

    // Try every mask and keep the least penalised, as the spec requires.
    var bestMask = 0;
    if (typeof forceMask === 'number' && forceMask >= 0) {
      bestMask = forceMask;
    } else {
      var bestPenalty = Infinity;
      for (var m = 0; m < 8; m += 1) {
        symbol.applyMask(m);
        symbol.drawFormatBits(m);
        var penalty = symbol.penalty();
        if (penalty < bestPenalty) {
          bestPenalty = penalty;
          bestMask = m;
        }
        symbol.applyMask(m); // XOR is its own inverse
      }
    }

    symbol.applyMask(bestMask);
    symbol.drawFormatBits(bestMask);

    return {
      size: symbol.size,
      modules: symbol.modules,
      version: version,
      mask: bestMask,
      level: LEVEL_NAMES[ecc.ordinal],
    };
  }

  /** Split into blocks, append ECC to each, then interleave as the spec requires. */
  function interleave(codewords, version, ecc) {
    var numBlocks = NUM_ECC_BLOCKS[ecc.ordinal][version];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version];
    var rawCodewords = Math.floor(rawDataModules(version) / 8);
    var numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    var shortDataLen = shortBlockLen - blockEccLen;
    var blocks = [];
    var divisor = reedSolomonDivisor(blockEccLen);
    var k = 0;

    for (var i = 0; i < numBlocks; i += 1) {
      var dat = codewords.slice(k, k + shortDataLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      var eccBytes = reedSolomonRemainder(dat, divisor);
      // Pad the short blocks with a placeholder so every block is the same
      // length. Without it the ECC of a short block sits one column early and
      // the whole interleave shifts under it.
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(eccBytes));
    }

    var result = [];
    for (var c = 0; c < blocks[0].length; c += 1) {
      for (var bIndex = 0; bIndex < blocks.length; bIndex += 1) {
        // ...and skip that placeholder column when reading back out.
        if (c === shortDataLen && bIndex < numShortBlocks) continue;
        result.push(blocks[bIndex][c]);
      }
    }

    return result;
  }

  global.QR = { encode: encode };
})(window);
