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
   * Font size at which a monospace glyph advances exactly `dots / chars`.
   * Measured rather than assumed, because the WebView's default monospace face
   * is not knowable in advance.
   */
  function fitFontSize(context, dotsPerChar) {
    context.font = '100px monospace';
    var advance = context.measureText('0').width;
    if (!advance) return Math.round(dotsPerChar / 0.6); // fall back to 0.6em
    return (dotsPerChar * 100) / advance;
  }

  function alignedX(width, contentWidth, align) {
    if (align === 'center') return Math.round((width - contentWidth) / 2);
    if (align === 'right') return Math.round(width - contentWidth);
    return 0;
  }

  /**
   * Draw a compiled document onto a canvas of the label's exact dot size.
   *
   * @param {object} compiled - result of Doc.compile()
   * @param {object} images - map of block id to prepared bitmap (already 1-bit)
   * @returns {{dataUrl, base64, width, height, contentDots, overflow}}
   */
  function render(compiled, images) {
    var paper = compiled.paper;
    var width = paper.dots;
    var height = Math.round(paper.heightMm * 8);

    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    var context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#000';
    context.textBaseline = 'top';

    var dotsPerChar = width / compiled.chars;
    var baseFont = fitFontSize(context, dotsPerChar);
    var y = 0;

    for (var i = 0; i < compiled.blocks.length; i += 1) {
      var block = compiled.blocks[i];

      if (block.type === 'text') {
        y = drawText(context, block, y, width, baseFont, dotsPerChar);
      } else if (block.type === 'bitmap') {
        y = drawBitmap(context, block, y, width, images);
      } else if (block.type === 'qr') {
        y = drawQr(context, block, y, width);
      } else if (block.type === 'barcode') {
        y = drawBarcode(context, block, y, width, baseFont, dotsPerChar);
      }
      // feed and formfeed are the printer's business, not the bitmap's.
    }

    threshold(context, width, height);

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

  function drawText(context, block, y, width, baseFont, dotsPerChar) {
    var scale = Doc.TEXT_SIZES[block.size] ? Doc.TEXT_SIZES[block.size].scale : 1;
    var fontPx = baseFont * scale;
    var lineHeight = fontPx * LINE_PITCH;

    context.font = fontPx + 'px monospace';

    var lines = String(block.text).split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (line.length) {
        // Monospace, so the width is the column count - no need to measure each
        // line, and this keeps it consistent with the column-based layout.
        var lineWidth = line.length * dotsPerChar * scale;
        context.fillText(line, alignedX(width, lineWidth, block.align), y);
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

  function drawBarcode(context, block, y, width, baseFont, dotsPerChar) {
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
      var fontPx = baseFont;
      context.font = fontPx + 'px monospace';
      var caption = String(block.data);
      var captionWidth = caption.length * dotsPerChar;
      y += CAPTION_GAP;
      context.fillText(caption, alignedX(width, captionWidth, block.align), y);
      y += fontPx * LINE_PITCH;
    }

    return y;
  }

  /**
   * Collapse to pure black and white.
   *
   * The printer burns a dot or it does not, and anti-aliased text arrives here
   * as grey. Images were dithered before they were drawn and are already 1-bit,
   * so a plain threshold leaves their dot pattern intact.
   */
  function threshold(context, width, height) {
    var imageData = context.getImageData(0, 0, width, height);
    var data = imageData.data;

    for (var i = 0; i < data.length; i += 4) {
      var luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      var value = luma < 128 ? 0 : 255;
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
  function renderCalibration(paper, pitchMm) {
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

    var fontPx = fitFontSize(context, width / 32) * 1.2;
    context.font = fontPx + 'px monospace';
    context.textBaseline = 'middle';
    context.textAlign = 'center';
    context.fillText(pitchMm.toFixed(3) + ' mm', width / 2, height / 2 - fontPx * 0.7);
    context.fillText(Math.round(pitchMm * 8) + ' dots', width / 2, height / 2 + fontPx * 0.7);
    context.textAlign = 'left';
    context.textBaseline = 'top';

    threshold(context, width, height);

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
  };
})(window);
