/**
 * Getting a compiled block list onto paper.
 *
 * A web page cannot reach a Sunmi print head directly. It goes through one of:
 *
 *   1. `android` - the bridge this APK injects as `window.AndroidPrinter`,
 *                  which binds the AIDL service `woyou.aidlservice.jiuiv5`.
 *   2. `sunmi`   - Sunmi's own H5 JS SDK, present in Sunmi Browser.
 *   3. `browser` - fallback: render at true paper width and call print().
 *
 * Inside this APK it is always (1). The rest exists so the same page can be
 * opened in a plain browser while iterating on the layout.
 */
(function (global) {
  "use strict";

  var BRIDGE_CANDIDATES = [
    { key: 'AndroidPrinter', type: 'android' },
    { key: 'PrinterBridge', type: 'android' },
    { key: 'sunmiPrinter', type: 'sunmi' },
    { key: 'SunmiPrinter', type: 'sunmi' },
    { key: 'sunmiInnerPrinter', type: 'sunmi' },
    { key: 'Android', type: 'android' },
  ];

  /** Text entry points, most specific first. */
  var TEXT_METHODS = ['printText', 'printTexts', 'printerText', 'printOriginalText', 'print'];

  /** Raw ESC/POS entry points, used when no text method exists. */
  var RAW_METHODS = ['sendEscCommand', 'sendRAWData'];

  function hasMethod(api, name) {
    return !!api && typeof api[name] === 'function';
  }

  function findMethod(api, names) {
    for (var i = 0; i < names.length; i += 1) {
      if (hasMethod(api, names[i])) return names[i];
    }
    return null;
  }

  /** @returns {{type, name, api}|null} */
  function getBridge() {
    for (var i = 0; i < BRIDGE_CANDIDATES.length; i += 1) {
      var candidate = BRIDGE_CANDIDATES[i];
      var api = global[candidate.key];
      if (!api || typeof api !== 'object') continue;
      if (findMethod(api, TEXT_METHODS) || findMethod(api, RAW_METHODS)) {
        return { type: candidate.type, name: candidate.key, api: api };
      }
    }
    return null;
  }

  /**
   * How a print will actually be delivered, for the status chip.
   * @returns {{channel, ready, label, hint}}
   */
  function describeChannel() {
    var bridge = getBridge();

    if (!bridge) {
      return {
        channel: 'browser',
        ready: false,
        label: 'No printer bridge',
        hint:
          'Running outside the Sunmi wrapper, so printing falls back to the ' +
          'browser dialog. On the device this reads "Printer connected".',
      };
    }

    if (bridge.type === 'sunmi') {
      return {
        channel: 'sunmi',
        ready: true,
        label: 'Sunmi bridge',
        hint: 'Prints straight to the built-in head via window.' + bridge.name + '.',
      };
    }

    // The wrapper binds the print service asynchronously, so the bridge can
    // exist while the printer behind it is not bound yet.
    var ready = true;
    var identity = '';
    try {
      if (hasMethod(bridge.api, 'isReady')) ready = !!bridge.api.isReady();
      if (hasMethod(bridge.api, 'getStatus')) identity = bridge.api.getStatus() || '';
    } catch (error) {
      ready = false;
    }

    return {
      channel: 'android',
      ready: ready,
      label: ready ? 'Printer connected' : 'Printer not bound',
      hint: ready
        ? 'Built-in printer' + (identity ? ' - ' + identity : '') + '.'
        : 'The bridge is here but woyou.aidlservice.jiuiv5 has not bound yet. ' +
          'Give it a moment, or check that the print service exists on this device.',
    };
  }

  /* ──────────────────────────────────────────────────────────────────────────
     Native printing
     ────────────────────────────────────────────────────────────────────────── */

  function callSafely(api, name) {
    var args = Array.prototype.slice.call(arguments, 2);
    if (!hasMethod(api, name)) return false;
    try {
      api[name].apply(api, args);
      return true;
    } catch (error) {
      // A single unsupported call must not cost us the rest of the document.
      if (global.console) console.error('Printer call ' + name + ' failed', error);
      return false;
    }
  }

  /**
   * Walk the compiled blocks, translating each into the printer's own calls.
   * @returns {boolean} whether anything was actually sent
   */
  /**
   * Feed an exact number of dots with ESC J, which advances 1/203 inch per
   * unit. lineWrap() cannot do this: it moves in whole text lines, and a line
   * is not a divisor of the gap between two stickers.
   *
   * @returns {boolean} whether the whole distance was sent
   */
  function feedDots(api, dots) {
    if (dots <= 0) return true;

    var raw = findMethod(api, RAW_METHODS);
    if (!raw) return false;

    // ESC J takes a single byte, so anything past 255 dots goes in chunks.
    var remaining = Math.round(dots);
    while (remaining > 0) {
      var step = Math.min(255, remaining);
      if (!callSafely(api, raw, Escpos.encodeBytes([0x1b, 0x4a, step]))) return false;
      remaining -= step;
    }
    return true;
  }

  /**
   * Print a sticker as one bitmap, then advance a fixed distance.
   *
   * This is the whole point of label mode: the bitmap is always exactly the
   * label's dot height, so the paper consumed per label is the same every time
   * and the next sticker lands under the head without anything having to sense
   * where it is.
   */
  function printLabel(api, compiled, label) {
    if (!hasMethod(api, 'printBitmapBase64')) return false;

    if (!callSafely(api, 'initLine')) callSafely(api, 'printerInit');
    // The bitmap is the full head width, so alignment is moot - but the printer
    // remembers it between jobs, and a stale centre would shift the image.
    callSafely(api, 'setAlignment', 0);

    if (!callSafely(api, 'printBitmapBase64', label.base64)) return false;

    if (compiled.feedDots > 0) {
      if (!feedDots(api, compiled.feedDots)) {
        // No raw channel to feed dots on; fall back to whole lines, which will
        // not register exactly but at least clears the label.
        callSafely(api, 'lineWrap', Math.max(1, Math.round(compiled.feedDots / 30)));
      }
    }

    return true;
  }

  function printViaBridge(bridge, compiled, label) {
    var api = bridge.api;

    // Label mode replaces the whole block-by-block path.
    if (compiled.paper.sticker && label) return printLabel(api, compiled, label);

    var textMethod = findMethod(api, TEXT_METHODS);
    var rawMethod = findMethod(api, RAW_METHODS);
    if (!textMethod && !rawMethod) return false;

    // Sunmi's H5 SDK opens a job with initLine(); this wrapper uses printerInit().
    if (!callSafely(api, 'initLine')) callSafely(api, 'printerInit');

    var blocks = compiled.blocks;
    var chars = compiled.chars;
    var sent = false;

    /**
     * Alignment is a printer mode, not a per-call argument, so it has to be set
     * before the write and put back to left afterwards - otherwise the next
     * block inherits it.
     */
    var withAlign = function (align, write) {
      var code = Doc.ALIGNMENTS[align];
      if (code) callSafely(api, 'setAlignment', code);
      write();
      if (code) callSafely(api, 'setAlignment', 0);
    };

    var writeText = function (text, align) {
      if (textMethod) {
        callSafely(api, textMethod, text);
      } else {
        // Raw ESC/POS has no alignment mode here, so pad the lines instead.
        callSafely(api, rawMethod, Escpos.encodeText(Doc.padForAlign(text, chars, align)));
      }
      sent = true;
    };

    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i];

      if (block.type === 'bitmap') {
        (function (b) {
          withAlign(b.align, function () {
            if (callSafely(api, 'printBitmapBase64', b.base64)) sent = true;
          });
        })(block);
      } else if (block.type === 'text') {
        (function (b) {
          var font = Doc.TEXT_SIZES[b.size] ? Doc.TEXT_SIZES[b.size].font : Doc.FONT_SIZE_NORMAL;
          var resize = font !== Doc.FONT_SIZE_NORMAL;

          withAlign(b.align, function () {
            // Changing the font also changes character width, so it is set and
            // reset around this block alone - a fixed-column block printed at
            // the wrong size comes out crooked.
            if (resize) callSafely(api, 'setFontSize', font);
            writeText(b.text + '\n', b.align);
            if (resize) callSafely(api, 'setFontSize', Doc.FONT_SIZE_NORMAL);
          });
        })(block);
      } else if (block.type === 'qr') {
        (function (b) {
          withAlign(b.align, function () {
            // errorLevel 3 = H (30%), the most tolerant of a smudged receipt.
            if (callSafely(api, 'printQRCode', b.data, b.moduleSize, 3)) {
              sent = true;
              callSafely(api, 'lineWrap', 1);
            } else {
              // No native QR - at least print the payload so it is not lost.
              writeText('\n' + b.data + '\n', b.align);
            }
          });
        })(block);
      } else if (block.type === 'barcode') {
        (function (b) {
          withAlign(b.align, function () {
            // 8 = CODE128, the only symbology that takes arbitrary text.
            if (callSafely(api, 'printBarCode', b.data, 8, b.height, 2, b.textPosition)) {
              sent = true;
              callSafely(api, 'lineWrap', 1);
            } else {
              writeText(b.data + '\n', b.align);
            }
          });
        })(block);
      } else if (block.type === 'feed') {
        if (!callSafely(api, 'lineWrap', block.lines)) writeText('\n\n\n', 'left');
      } else if (block.type === 'formfeed') {
        // Advance to the start of the next die-cut label. Sunmi's label-capable
        // firmware exposes this as labelOutput() on the newer printer service;
        // where that is absent, GS FF is the ESC/POS command the gap sensor
        // acts on. Feeding lines is the last resort and only approximates it.
        if (!callSafely(api, 'labelOutput')) {
          var raw = findMethod(api, RAW_METHODS);
          if (raw) callSafely(api, raw, Escpos.FORM_FEED);
          else callSafely(api, 'lineWrap', 3);
        }
      }
    }

    // autoOut() is the H5 SDK's feed-and-present; cutPaper() the AIDL wrapper's.
    // Neither belongs on die-cut stock - the label is peeled off its liner, and
    // the form feed above has already positioned the next one.
    if (!compiled.paper.sticker) {
      if (!callSafely(api, 'autoOut')) callSafely(api, 'cutPaper');
    }

    return sent;
  }

  /* ──────────────────────────────────────────────────────────────────────────
     ESC/POS, for bridges that only accept raw bytes
     ────────────────────────────────────────────────────────────────────────── */

  var Escpos = {
    /** @returns {string} base64 of a raw byte sequence */
    encodeBytes: function (bytes) {
      var binary = '';
      for (var b = 0; b < bytes.length; b += 1) binary += String.fromCharCode(bytes[b] & 0xff);
      return btoa(binary);
    },

    /** @returns {string} base64 ESC/POS for one chunk of text */
    encodeText: function (text) {
      var bytes = [0x1b, 0x40]; // ESC @ - initialise
      var encoded = unescape(encodeURIComponent(text)); // UTF-8 as a byte string
      for (var i = 0; i < encoded.length; i += 1) bytes.push(encoded.charCodeAt(i) & 0xff);
      return Escpos.encodeBytes(bytes);
    },
  };

  /** GS FF - print and feed to the next label peak, per the gap sensor. */
  Escpos.FORM_FEED = Escpos.encodeBytes([0x1d, 0x0c]);

  /* ──────────────────────────────────────────────────────────────────────────
     Rendering - shared by the preview and the browser fallback
     ────────────────────────────────────────────────────────────────────────── */

  function escapeHtml(value) {
    return String(value).replace(/[&<>]/g, function (char) {
      return char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;';
    });
  }

  /**
   * Render compiled blocks as HTML at real paper width, so what the preview
   * shows is what the fallback prints.
   * @param {boolean} forPrint - the print frame needs the trailing feed as space
   */
  function blocksToHtml(compiled, forPrint) {
    var html = '';

    for (var i = 0; i < compiled.blocks.length; i += 1) {
      var block = compiled.blocks[i];
      var align = block.align || 'left';

      if (block.type === 'bitmap') {
        html +=
          '<div class="r-row r-' + align + '">' +
          '<img class="r-img" src="' + block.dataUrl + '" alt="" /></div>';
      } else if (block.type === 'text') {
        html +=
          '<pre class="r-text r-' + align + ' r-size-' + block.size + '">' +
          escapeHtml(block.text) +
          '</pre>';
      } else if (block.type === 'qr' || block.type === 'barcode') {
        html +=
          '<div class="r-row r-' + align + '"><div class="r-code">' +
          '<span class="r-code-tag">' + (block.type === 'qr' ? 'QR' : 'BARCODE') + '</span>' +
          escapeHtml(block.data) +
          '</div></div>';
      } else if (block.type === 'feed' && forPrint) {
        html += '<div style="height:' + block.lines * 4 + 'mm"></div>';
      }
    }

    return html;
  }

  function printViaBrowser(compiled, label) {
    return new Promise(function (resolve, reject) {
      var widthMm = compiled.paper.widthMm;
      var chars = compiled.chars;
      // What the head can actually reach, which is narrower than the stock.
      var printableMm = compiled.paper.printableMm;
      var fontMm = printableMm / chars / 0.6; // monospace advance is about 0.6em
      // Die-cut stock is a fixed page; roll stock is as long as it needs to be.
      var pageSize = compiled.paper.heightMm
        ? widthMm + 'mm ' + compiled.paper.heightMm + 'mm'
        : widthMm + 'mm auto';

      var iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText =
        'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
      document.body.appendChild(iframe);

      var cleanup = function () {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      };

      var doc = iframe.contentWindow && iframe.contentWindow.document;
      if (!doc) {
        cleanup();
        reject(new Error('Unable to open a print frame'));
        return;
      }

      doc.open();
      doc.write(
        '<!doctype html><html><head><meta charset="utf-8"><title>Print</title><style>' +
          '@page { size: ' + pageSize + '; margin: 0; }' +
          'html,body { margin:0; padding:0; background:#fff; }' +
          'body { width:' + printableMm + 'mm; padding:2mm; }' +
          '.r-row { display:block; }' +
          '.r-left { text-align:left; } .r-center { text-align:center; } .r-right { text-align:right; }' +
          // Already dithered to 1-bit at head resolution - land it 1:1 rather
          // than letting the browser resample it back to mush.
          '.r-img { display:inline-block; max-width:100%; image-rendering:pixelated; }' +
          '.r-text { margin:0; font-family:"Courier New",monospace; font-size:' + fontMm.toFixed(2) + 'mm;' +
          ' line-height:1.25; font-weight:700; color:#000; white-space:pre-wrap; }' +
          '.r-size-large { font-size:' + (fontMm * 1.5).toFixed(2) + 'mm; }' +
          '.r-size-xlarge { font-size:' + (fontMm * 2).toFixed(2) + 'mm; }' +
          '.r-code { display:inline-block; margin:2mm 0; padding:2mm; border:0.4mm dashed #000;' +
          ' font-family:"Courier New",monospace; font-size:' + (fontMm * 0.9).toFixed(2) + 'mm; word-break:break-all; }' +
          '.r-code-tag { display:block; font-weight:700; }' +
          // Label mode has already rendered the sticker to a bitmap at the
          // head's exact dot pitch; print that rather than re-laying it out.
          '.r-label { display:block; width:' + printableMm + 'mm; image-rendering:pixelated; }' +
          '</style></head><body>' +
          (compiled.paper.sticker && label
            ? '<img class="r-label r-img" src="' + label.dataUrl + '" alt="" />'
            : blocksToHtml(compiled, true)) +
          '</body></html>'
      );
      doc.close();

      var fire = function () {
        try {
          iframe.contentWindow.focus();
          iframe.contentWindow.print();
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          // Chrome needs the frame alive until the dialog is handled.
          setTimeout(cleanup, 1000);
        }
      };

      // An <img> is not necessarily decoded when the document reports complete,
      // and printing early leaves a blank hole where the image should be.
      var fireWhenPainted = function () {
        var images = doc.querySelectorAll('img.r-img');
        var waiting = 0;

        var done = function () {
          waiting -= 1;
          if (waiting <= 0) fire();
        };

        for (var i = 0; i < images.length; i += 1) {
          if (images[i].complete) continue;
          waiting += 1;
          images[i].addEventListener('load', done, false);
          images[i].addEventListener('error', done, false);
        }

        if (waiting === 0) fire();
      };

      if (doc.readyState === 'complete') fireWhenPainted();
      else iframe.onload = fireWhenPainted;
    });
  }

  /**
   * Print through the best channel available.
   * @returns {Promise<{channel: string}>}
   */
  function print(compiled, label) {
    if (!compiled.blocks.length) {
      return Promise.reject(new Error('Nothing to print'));
    }

    var bridge = getBridge();

    if (bridge) {
      try {
        if (printViaBridge(bridge, compiled, label)) {
          return Promise.resolve({ channel: bridge.type });
        }
      } catch (error) {
        if (global.console) console.error('Bridge print failed, falling back', error);
      }
    }

    return printViaBrowser(compiled, label).then(function () {
      return { channel: 'browser' };
    });
  }

  global.PrinterBridgeClient = {
    getBridge: getBridge,
    describeChannel: describeChannel,
    blocksToHtml: blocksToHtml,
    print: print,
  };
})(window);
