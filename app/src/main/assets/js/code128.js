/**
 * CODE128 encoding.
 *
 * Needed for the same reason as qr.js: in label mode the whole sticker is one
 * bitmap of an exactly known height, so a barcode drawn by the printer cannot
 * be part of it and has to be generated here.
 *
 * Subsets B and C only. B covers printable ASCII (32..126), which is every
 * character a label carries; C packs pairs of digits into one symbol and is
 * switched to automatically for digit runs long enough to pay for the switch.
 */
(function (global) {
  "use strict";

  /**
   * Bar/space widths for symbol values 0..106, three bars and three spaces
   * each, alternating and starting with a bar. Every symbol is 11 modules wide
   * except the stop pattern, which carries an extra bar and is 13.
   */
  var PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
    '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
    '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
    '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
    '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
    '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
    '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
    '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
    '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
    '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
    '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
    '211214', '211232', '2331112',
  ];

  var START_B = 104;
  var START_C = 105;
  var STOP = 106;
  var CODE_B = 100; // switch-to-B, when read while in C
  var CODE_C = 99;  // switch-to-C, when read while in B

  function isDigit(ch) {
    return ch >= '0' && ch <= '9';
  }

  /** Length of the run of digits starting at `i`. */
  function digitRun(text, i) {
    var n = 0;
    while (i + n < text.length && isDigit(text.charAt(i + n))) n += 1;
    return n;
  }

  /**
   * Worth switching to subset C? Each switch costs one symbol, and C halves the
   * symbols for the digits it covers - so it pays from four digits at the very
   * start or end of the barcode, and six in the middle.
   */
  function shouldUseC(run, atStart, reachesEnd) {
    if (atStart || reachesEnd) return run >= 4;
    return run >= 6;
  }

  /**
   * @param {string} text - printable ASCII; anything outside 32..126 is dropped
   * @returns {number[]} symbol values, without the start code or checksum
   */
  function toCodes(text) {
    var codes = [];
    var mode = null;
    var i = 0;

    while (i < text.length) {
      var run = digitRun(text, i);

      if (shouldUseC(run, i === 0, i + run === text.length)) {
        // An odd run leaves its last digit to subset B.
        var pairs = Math.floor(run / 2);
        if (mode !== 'C') {
          codes.push(mode === null ? START_C : CODE_C);
          mode = 'C';
        }
        for (var p = 0; p < pairs; p += 1) {
          codes.push(parseInt(text.substr(i + p * 2, 2), 10));
        }
        i += pairs * 2;
        continue;
      }

      if (mode !== 'B') {
        codes.push(mode === null ? START_B : CODE_B);
        mode = 'B';
      }

      var code = text.charCodeAt(i);
      // Subset B spans ASCII 32..126, mapped to values 0..94.
      if (code >= 32 && code <= 126) codes.push(code - 32);
      i += 1;
    }

    if (!codes.length) codes.push(START_B);
    return codes;
  }

  /**
   * Encode text as a run of modules.
   *
   * @param {string} text
   * @returns {{modules: boolean[], codes: number[], check: number}} `modules`
   *   is one entry per module, true where a bar is; the caller scales it.
   */
  function encode(text) {
    var codes = toCodes(String(text));

    // Checksum: the start code plus each subsequent value weighted by its
    // position, modulo 103.
    var sum = codes[0];
    for (var i = 1; i < codes.length; i += 1) sum += codes[i] * i;
    var check = sum % 103;

    var all = codes.concat([check, STOP]);
    var modules = [];

    for (var c = 0; c < all.length; c += 1) {
      var pattern = PATTERNS[all[c]];
      for (var p = 0; p < pattern.length; p += 1) {
        var width = Number(pattern.charAt(p));
        // Patterns alternate bar, space, bar, space... starting with a bar.
        var dark = p % 2 === 0;
        for (var w = 0; w < width; w += 1) modules.push(dark);
      }
    }

    return { modules: modules, codes: all, check: check };
  }

  global.Code128 = {
    PATTERNS: PATTERNS,
    encode: encode,
    toCodes: toCodes,
  };
})(window);
