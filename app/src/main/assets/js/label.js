/**
 * Rendering a whole sticker as one bitmap.
 *
 * WHY THIS EXISTS
 *
 * A printer with a gap sensor finds the next label by itself. Without one, the
 * only way to land on the next label is to advance a fixed distance every time
 * — which means the distance already consumed has to be known exactly, not
 * estimated. Printing text natively cannot give that: the height depends on the
 * printer's own font metrics and line spacing, and a few dots of error per
 * label compounds until the layout walks off the sticker.
 *
 * So in label mode nothing is printed natively. The entire sticker is drawn
 * here into a canvas of exactly `dots × heightMm * 8` and sent as a single
 * bitmap. Every label then consumes exactly the same number of dots — the
 * bitmap height — no matter what is on it, and the feed that follows is a
 * constant. Registration becomes arithmetic instead of a guess.
 *
 * It also means the preview is the bitmap, so it is exact rather than
 * representative.
 */
(function (global) {
  "use strict";

  /** Vertical pitch as a multiple of the font size, matching Doc.LINE_PITCH. */
  var LINE_PITCH = 1.25;

  /** Module width of a CODE128 bar, in dots. Below 2 most scanners struggle. */
  var BARCODE_MODULE_DOTS = 2;

  /** Gap between a barcode and its caption, in dots. */
  var CAPTION_GAP = 4;

  /**
   * How hard text is inked onto the bitmap.
   *
   * Three independent things decide whether a stroke survives the trip to
   * paper, and the right combination depends on the head, the stock and how
   * worn the printer is - so all three are settings rather than constants.
   *
   * `weight` picks the face: 'bold' or anything else for the regular one. A
   * bold monospace has stems drawn thicker by the type designer, which beats
   * any amount of redrawing a light face - and in a monospace it costs nothing,
   * because bold keeps the same advance and so shifts no column.
   *
   * `strokeX` and `strokeY` are how far, in dots, each line is redrawn to
   * thicken it. A one-dot stroke is at the edge of what a 203dpi head burns
   * reliably - it comes out grey and patchy even when the bitmap says solid
   * black. They are separate because they fix different things: strokeX widens
   * the vertical stems, strokeY the horizontal bars (the crossbar of an H, the
   * waist of an e). An x-only boost leaves every horizontal stroke exactly as
   * thin as it was, which is the usual reason text still looks broken.
   *
   * `family` is the CSS font family. Monospace is the default and the only one
   * the column layout is correct for - dividers, two-column rows and the wrap
   * width are all counted in characters, so a proportional face will not line
   * up. It is offered anyway because a plain label of centred text has no
   * columns to break, and a sans face is noticeably cleaner at these sizes.
   *
   * `pitch` is the line advance as a multiple of the font size.
   *
   * `threshold` is the luminance below which a pixel becomes a burned dot. Not
   * the midpoint, deliberately. Canvas text arrives anti-aliased: a stem a
   * single dot wide is never drawn solid, it is spread as partial coverage over
   * two columns, and at a 128 cut-off both halves fall on the white side and the
   * stem disappears.
   *
   * Only text is affected by any of this. Images arrive already 1-bit, and QR
   * and barcode modules are whole-dot rectangles, so none of them have grey to
   * lose or hairlines to thicken.
   */
  var INK_LEVELS = {
    light: { weight: 'normal', strokeX: 0, strokeY: 0, threshold: 160, label: 'Light' },
    normal: { weight: 'bold', strokeX: 0.5, strokeY: 0.5, threshold: 200, label: 'Normal' },
    heavy: { weight: 'bold', strokeX: 1, strokeY: 1, threshold: 224, label: 'Heavy' },
  };

  var DEFAULT_INK = 'normal';

  /** Font families offered, keyed by the value stored in the document. */
  var INK_FAMILIES = {
    monospace: { css: 'monospace', label: 'Mono', columns: true },
    sans: { css: 'sans-serif', label: 'Sans', columns: false },
    serif: { css: 'serif', label: 'Serif', columns: false },
  };

  /** Ranges the settings are allowed to take, shared with the Setup sliders. */
  var INK_BOUNDS = {
    stroke: { min: 0, max: 2, step: 0.25 },
    threshold: { min: 128, max: 248, step: 8 },
    pitch: { min: 1, max: 2.5, step: 0.05 },
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function inkNumber(value, fallback, bounds) {
    if (typeof value !== 'number' || !isFinite(value)) return fallback;
    return clamp(value, bounds.min, bounds.max);
  }

  /**
   * Turn a preset name or a settings object into the shape the renderer wants.
   *
   * The stored form is what a person adjusts - keywords and numbers. The render
   * form pre-builds the CSS font prefix and fills every field in, so nothing
   * downstream has to test for a missing one.
   */
  function inkLevel(ink) {
    var base = INK_LEVELS[DEFAULT_INK];
    var settings = typeof ink === 'string' ? INK_LEVELS[ink] : ink;
    if (!settings) settings = base;

    var family = INK_FAMILIES[settings.family] ? settings.family : 'monospace';

    return {
      family: family,
      strokeX: inkNumber(settings.strokeX, base.strokeX, INK_BOUNDS.stroke),
      strokeY: inkNumber(settings.strokeY, base.strokeY, INK_BOUNDS.stroke),
      threshold: inkNumber(settings.threshold, base.threshold, { min: 1, max: 254 }),
      pitch: inkNumber(settings.pitch, LINE_PITCH, INK_BOUNDS.pitch),
      // Canvas wants "<weight> <size>px <family>"; empty weight means the
      // default face. Cached whole so it is not rebuilt for every line.
      font: (settings.weight === 'bold' ? 'bold ' : '') + '$px ' + INK_FAMILIES[family].css,
      weight: settings.weight === 'bold' ? 'bold' : 'normal',
    };
  }

  /** The CSS font string for `ink` at `px`. */
  function inkFont(ink, px) {
    return ink.font.replace('$', px);
  }

  /**
   * Validate a preset name or settings object into the *stored* form - the
   * shape a person edits and the document keeps. inkLevel() turns that into the
   * render form; keeping the two apart means the Setup controls always show
   * what was set rather than something derived from it.
   */
  function inkSettings(ink) {
    var resolved = inkLevel(ink);
    return {
      family: resolved.family,
      weight: resolved.weight,
      strokeX: resolved.strokeX,
      strokeY: resolved.strokeY,
      threshold: resolved.threshold,
      pitch: resolved.pitch,
    };
  }

  /** The preset `settings` exactly matches, or '' for a hand-tuned combination. */
  function inkPresetName(settings) {
    var current = inkSettings(settings);
    for (var name in INK_LEVELS) {
      var preset = inkSettings(INK_LEVELS[name]);
      if (preset.weight === current.weight &&
          preset.strokeX === current.strokeX &&
          preset.strokeY === current.strokeY &&
          preset.threshold === current.threshold &&
          preset.family === current.family &&
          preset.pitch === current.pitch) {
        return name;
      }
    }
    return '';
  }

  /**
   * Font size at which a monospace glyph advances exactly `dots / chars`.
   * Measured rather than assumed, because the WebView's default monospace face
   * is not knowable in advance.
   *
   * Floored to whole dots: a fractional size puts glyph edges on half-dot
   * boundaries, where anti-aliasing smears them, and rounding down rather than
   * up keeps a full-width row inside the head.
   */
  function fitFontSize(context, dotsPerChar, ink) {
    context.font = inkFont(ink, 100);
    var advance = context.measureText('0').width;
    if (!advance) return Math.floor(dotsPerChar / 0.6); // fall back to 0.6em
    return Math.max(1, Math.floor((dotsPerChar * 100) / advance));
  }

  /**
   * Draw one line of text, thickened per the ink level.
   *
   * @param {number} [dx] which way the horizontal copy is offset. Defaults to
   *   rightward; pass a negative to thicken leftward instead.
   */
  function inkText(context, text, x, y, ink, dx) {
    var bx = typeof dx === 'number' ? dx : ink.strokeX;
    context.fillText(text, x, y);
    if (ink.strokeX) context.fillText(text, x + bx, y);
    if (ink.strokeY) {
      context.fillText(text, x, y + ink.strokeY);
      if (ink.strokeX) context.fillText(text, x + bx, y + ink.strokeY);
    }
  }

  /**
   * Which way a line should thicken: away from the paper edge it is against.
   * A row laid out flush right is already at the last dot of the head, and
   * thickening it outward would clip the final glyph.
   */
  function boostDirection(x, lineWidth, width, ink) {
    var overruns = x + lineWidth + ink.strokeX > width;
    return overruns && x >= ink.strokeX ? -ink.strokeX : ink.strokeX;
  }

  function alignedX(width, contentWidth, align) {
    if (align === 'center') return Math.round((width - contentWidth) / 2);
    if (align === 'right') return Math.round(width - contentWidth);
    return 0;
  }

  /**
   * Lay every block out, drawing into `context`, and return the height used.
   *
   * Split out from render() because a continuous roll has no height to draw
   * into until this has been run once - see render().
   */
  function drawBlocks(context, compiled, images, ink, width) {
    var dotsPerChar = width / compiled.chars;
    var baseFont = fitFontSize(context, dotsPerChar, ink);
    var y = 0;

    for (var i = 0; i < compiled.blocks.length; i += 1) {
      var block = compiled.blocks[i];

      // Every block starts on a whole dot. A block that ends on a fraction -
      // a barcode caption does - would otherwise push everything after it half
      // a dot down, and half-dot text is blurred text.
      y = Math.round(y);

      if (block.type === 'text') {
        y = drawText(context, block, y, width, baseFont, dotsPerChar, ink);
      } else if (block.type === 'bitmap') {
        y = drawBitmap(context, block, y, width, images);
      } else if (block.type === 'qr') {
        y = drawQr(context, block, y, width);
      } else if (block.type === 'barcode') {
        y = drawBarcode(context, block, y, width, baseFont, dotsPerChar, ink);
      }
      // feed and formfeed are the printer's business, not the bitmap's.
    }

    return y;
  }

  /**
   * How tall the blocks come out, by laying them out on a throwaway context.
   *
   * Drawing past the edge of a canvas is a no-op and measureText does not care
   * how tall it is, so a one-dot scratch canvas measures a full receipt.
   */
  function measureBlocks(compiled, images, ink, width) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = 1;

    var context = canvas.getContext('2d', { willReadFrequently: true });
    context.textBaseline = 'top';
    return drawBlocks(context, compiled, images, ink, width);
  }

  /**
   * Draw a compiled document onto a canvas at the head's exact dot pitch.
   *
   * @param {object} compiled - result of Doc.compile()
   * @param {object} images - map of block id to prepared bitmap (already 1-bit)
   * @param {string|object} [inkName] - preset name or settings; see inkLevel
   * @returns {{dataUrl, base64, width, height, contentDots, overflow}}
   */
  function render(compiled, images, inkName) {
    var ink = inkLevel(inkName);
    var paper = compiled.paper;
    var width = paper.dots;

    // Die-cut stock gets a fixed canvas: every sticker has to consume exactly
    // the same number of dots or the sensorless advance drifts, so content is
    // clipped to the label rather than the label grown to the content.
    // A continuous roll has no such constraint and is measured instead - a
    // receipt must not feed a fixed slab of blank paper after every job.
    var height = paper.heightMm
      ? Math.round(paper.heightMm * 8)
      : Math.max(8, Math.round(measureBlocks(compiled, images, ink, width)));

    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    var context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#000';
    context.textBaseline = 'top';

    var y = drawBlocks(context, compiled, images, ink, width);

    threshold(context, width, height, ink);

    var dataUrl = canvas.toDataURL('image/png');
    return {
      dataUrl: dataUrl,
      base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      width: width,
      height: height,
      contentDots: Math.round(y),
      overflow: y > height,
    };
  }

  function drawText(context, block, y, width, baseFont, dotsPerChar, ink) {
    var scale = Doc.TEXT_SIZES[block.size] ? Doc.TEXT_SIZES[block.size].scale : 1;
    var fontPx = Math.max(1, Math.round(baseFont * scale));
    var lineHeight = Math.round(fontPx * ink.pitch);

    context.font = inkFont(ink, fontPx);

    // Fallback only - each line is measured as drawn below, which is what makes
    // a proportional family align correctly instead of being laid out as though
    // every glyph were the width of a '0'.
    var advance = context.measureText('0').width || dotsPerChar * scale;

    var lines = String(block.text).split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (line.length) {
        var lineWidth = context.measureText(line).width || line.length * advance;
        var x = alignedX(width, lineWidth, block.align);
        inkText(context, line, x, y, ink, boostDirection(x, lineWidth, width, ink));
      }
      y += lineHeight;
    }

    return y;
  }

  function drawBitmap(context, block, y, width, images) {
    var prepared = images && images[block.sourceId];
    var source = prepared || block;
    if (!source.dataUrl || !source.image) {
      // The <img> is preloaded by the caller; without it there is nothing to
      // draw and the block is skipped rather than leaving a gap.
      return y;
    }

    var x = alignedX(width, source.width, block.align);
    // Drawn 1:1 - the bitmap was already dithered to these exact dots, and
    // resampling it here would turn the dot pattern back into grey mush.
    context.drawImage(source.image, x, Math.round(y), source.width, source.height);
    return y + source.height;
  }

  function drawQr(context, block, y, width) {
    var symbol;
    try {
      symbol = QR.encode(block.data, 'M');
    } catch (error) {
      if (global.console) console.error('QR payload too large', error);
      return y;
    }

    var moduleDots = block.moduleSize;
    var size = symbol.size * moduleDots;
    var x = alignedX(width, size, block.align);

    context.fillStyle = '#000';
    for (var row = 0; row < symbol.size; row += 1) {
      for (var col = 0; col < symbol.size; col += 1) {
        if (!symbol.modules[row][col]) continue;
        context.fillRect(x + col * moduleDots, Math.round(y) + row * moduleDots, moduleDots, moduleDots);
      }
    }

    return y + size;
  }

  function drawBarcode(context, block, y, width, baseFont, dotsPerChar, ink) {
    var encoded = Code128.encode(block.data);
    var barWidth = BARCODE_MODULE_DOTS;
    var totalWidth = encoded.modules.length * barWidth;

    // A barcode wider than the head cannot be scanned anyway; drop to a
    // one-dot module before letting it run off the edge.
    if (totalWidth > width) {
      barWidth = 1;
      totalWidth = encoded.modules.length;
    }

    var x = alignedX(width, totalWidth, block.align);
    var barHeight = block.height;

    context.fillStyle = '#000';
    for (var m = 0; m < encoded.modules.length; m += 1) {
      if (!encoded.modules[m]) continue;
      context.fillRect(x + m * barWidth, Math.round(y), barWidth, barHeight);
    }

    y += barHeight;

    if (block.textPosition) {
      var fontPx = Math.max(1, Math.round(baseFont));
      context.font = inkFont(ink, fontPx);
      var caption = String(block.data);
      var captionWidth = context.measureText(caption).width || caption.length * dotsPerChar;
      var captionX = alignedX(width, captionWidth, block.align);
      y = Math.round(y + CAPTION_GAP);
      inkText(context, caption, captionX, y, ink,
        boostDirection(captionX, captionWidth, width, ink));
      y += Math.round(fontPx * ink.pitch);
    }

    return y;
  }

  /**
   * Collapse to pure black and white.
   *
   * The printer burns a dot or it does not, and anti-aliased text arrives here
   * as grey. Images were dithered before they were drawn and are already 1-bit,
   * so a plain threshold leaves their dot pattern intact.
   *
   * See INK_LEVELS for why the cut-off is not the midpoint.
   */
  function threshold(context, width, height, ink) {
    var cut = (ink || inkLevel()).threshold;
    var imageData = context.getImageData(0, 0, width, height);
    var data = imageData.data;

    for (var i = 0; i < data.length; i += 4) {
      var luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      var value = luma < cut ? 0 : 255;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }

    context.putImageData(imageData, 0, 0);
  }

  /**
   * A sticker with a bar pinned to its top and bottom edge.
   *
   * Printed a few times in a row this is the whole diagnostic for a sensorless
   * printer: the bars can only stay on the edges if the pitch matches the
   * stock. Creeping up means the pitch is short, creeping down means it is
   * long, and the drift per label is the error.
   */
  function renderCalibration(paper, pitchMm, inkName) {
    var ink = inkLevel(inkName);
    var width = paper.dots;
    var height = Math.round(paper.heightMm * 8);
    var bar = 4; // dots

    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    var context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#000';

    context.fillRect(0, 0, width, bar);
    context.fillRect(0, height - bar, width, bar);

    // Side ticks make a sideways shift visible as well as a vertical one.
    context.fillRect(0, 0, bar, height);
    context.fillRect(width - bar, 0, bar, height);

    var fontPx = Math.round(fitFontSize(context, width / 32, ink) * 1.2);
    context.font = inkFont(ink, fontPx);
    context.textBaseline = 'middle';
    context.textAlign = 'center';
    inkText(context, pitchMm.toFixed(3) + ' mm', width / 2,
      Math.round(height / 2 - fontPx * 0.7), ink);
    inkText(context, Math.round(pitchMm * 8) + ' dots', width / 2,
      Math.round(height / 2 + fontPx * 0.7), ink);
    context.textAlign = 'left';
    context.textBaseline = 'top';

    threshold(context, width, height, ink);

    var dataUrl = canvas.toDataURL('image/png');
    return {
      dataUrl: dataUrl,
      base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      width: width,
      height: height,
      contentDots: height,
      overflow: false,
    };
  }

  global.Label = {
    render: render,
    renderCalibration: renderCalibration,
    LINE_PITCH: LINE_PITCH,
    BARCODE_MODULE_DOTS: BARCODE_MODULE_DOTS,
    INK_LEVELS: INK_LEVELS,
    INK_FAMILIES: INK_FAMILIES,
    INK_BOUNDS: INK_BOUNDS,
    DEFAULT_INK: DEFAULT_INK,
    inkLevel: inkLevel,
    inkSettings: inkSettings,
    inkPresetName: inkPresetName,
  };
})(window);
