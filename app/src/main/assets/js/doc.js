/**
 * The document model.
 *
 * A document starts empty and is whatever the user builds: an ordered list of
 * blocks, each one a thing the printer can put on paper. Nothing here knows
 * about receipts, orders or totals - a receipt is just one arrangement of these
 * blocks, and so is a label, a ticket, a note or a queue number.
 *
 * Authored blocks (what the editor edits):
 *   { type: "text",    text, align, size }
 *   { type: "columns", left, right }
 *   { type: "divider", char }
 *   { type: "space",   lines }
 *   { type: "image",   source, dataUrl, widthPct, align }
 *   { type: "qr",      data, moduleSize, align }
 *   { type: "barcode", data, height, showText, align }
 *
 * compile() turns those into render blocks - text wrapped to the paper, images
 * resolved to dithered bitmaps - which the preview and the printer both walk.
 */
(function (global) {
  "use strict";

  /** Sunmi print heads are 203dpi, which is exactly 8 dots per millimetre. */
  var DOTS_PER_MM = 8;

  /**
   * Paper presets, keyed by name.
   *
   * `printableMm` is what the head can actually reach, which is NOT the stock
   * width: the head is 384 dots (48mm) on a 58mm-class printer, so a 50mm
   * sticker gets 48mm of ink and a 1mm dead margin each side. `chars` is the
   * column count at the default font, `dots` the head resolution an image is
   * scaled to.
   *
   * `heightMm` is set only for die-cut stock, where the print is bounded top
   * and bottom as well and overrunning it prints onto the next label.
   */
  var PAPER_SIZES = {
    '58': {
      widthMm: 58, printableMm: 48, chars: 32, dots: 384,
      label: '58 mm', short: '58 mm', roll: true,
    },
    '80': {
      widthMm: 80, printableMm: 72, chars: 48, dots: 576,
      label: '80 mm', short: '80 mm', roll: true,
    },
    '50x30': {
      widthMm: 50, printableMm: 48, chars: 32, dots: 384,
      heightMm: 30, label: '50 × 30 mm sticker', short: '50×30', sticker: true,
    },
  };

  var DEFAULT_PAPER = '58';

  /** Sunmi's default text size; anything we change has to be reset to this. */
  var FONT_SIZE_NORMAL = 24;

  /**
   * Vertical pitch as a multiple of the font height. The printer adds leading
   * between lines, so a 24-dot font does not advance 24 dots. This is the one
   * number the height estimate hangs on - if a label comes out consistently
   * short or long, calibrate here.
   */
  var LINE_PITCH = 1.25;

  var TEXT_SIZES = {
    normal: { font: FONT_SIZE_NORMAL, label: 'Normal', scale: 1 },
    large: { font: 36, label: 'Large', scale: 1.5 },
    xlarge: { font: 48, label: 'Huge', scale: 2 },
  };

  var ALIGNMENTS = { left: 0, center: 1, right: 2 };

  var DIVIDER_CHARS = ['-', '=', '.', '*', '~', '_'];

  /** Every block type the palette can add, in the order it is offered. */
  var BLOCK_TYPES = [
    { type: 'text', label: 'Text', icon: 'T' },
    { type: 'columns', label: 'Two columns', icon: '↔' },
    { type: 'divider', label: 'Line', icon: '—' },
    { type: 'space', label: 'Space', icon: '␣' },
    { type: 'image', label: 'Image', icon: '▣' },
    { type: 'qr', label: 'QR code', icon: '⌘' },
    { type: 'barcode', label: 'Barcode', icon: '|||' },
  ];

  var nextId = 1;

  /** Ids only need to be unique within a session - they key caches, not storage. */
  function claimId(used) {
    if (typeof used === 'number' && used >= nextId) nextId = used + 1;
    return nextId++;
  }

  /** A new block of `type`, with sensible starting values. */
  function createBlock(type) {
    var block = { id: claimId(), type: type };

    if (type === 'text') {
      block.text = '';
      block.align = 'left';
      block.size = 'normal';
    } else if (type === 'columns') {
      block.left = '';
      block.right = '';
    } else if (type === 'divider') {
      block.char = '-';
    } else if (type === 'space') {
      block.lines = 1;
    } else if (type === 'image') {
      // The bundled image is the starting pick, so an image block prints
      // something the moment it is added.
      block.source = 'default';
      block.dataUrl = '';
      block.widthPct = 70;
      block.align = 'center';
    } else if (type === 'qr') {
      block.data = '';
      block.moduleSize = 6;
      block.align = 'center';
    } else if (type === 'barcode') {
      block.data = '';
      block.height = 80;
      block.showText = true;
      block.align = 'center';
    }

    return block;
  }

  /** An empty document - what the app opens on and what Reset restores. */
  function defaultState() {
    return {
      paper: DEFAULT_PAPER,
      feedLines: 3,
      // Sticker stock only: advance to the start of the next label after
      // printing, instead of feeding a fixed number of lines.
      labelFeed: true,
      /**
       * Distance from the top of one sticker to the top of the next: the label
       * itself plus the die-cut gap. On a printer with no gap sensor this is
       * the only thing that keeps successive labels registered, so it is a
       * setting rather than a constant - rolls vary, and it is calibrated
       * against the actual stock.
       */
      labelPitchMm: 33,
      /** How many identical stickers one Print produces. */
      copies: 1,
      blocks: [],
    };
  }

  /* ──────────────────────────────────────────────────────────────────────────
     Text helpers - laid out in `chars` monospace columns
     ────────────────────────────────────────────────────────────────────────── */

  function repeat(char, count) {
    var out = '';
    for (var i = 0; i < count; i += 1) out += char;
    return out;
  }

  function twoCol(left, right, chars) {
    var l = String(left);
    var r = String(right);
    var gap = Math.max(1, chars - l.length - r.length);
    return (l + repeat(' ', gap) + r).slice(0, chars);
  }

  /** Word-wrap, breaking mid-word only when a single word is longer than the line. */
  function wrap(text, chars) {
    var out = [];
    var paragraphs = String(text).split('\n');

    for (var p = 0; p < paragraphs.length; p += 1) {
      var words = paragraphs[p].split(/\s+/);
      var line = '';

      for (var i = 0; i < words.length; i += 1) {
        var word = words[i];
        if (!word) continue;

        while (word.length > chars) {
          if (line) {
            out.push(line);
            line = '';
          }
          out.push(word.slice(0, chars));
          word = word.slice(chars);
        }

        if (!line) line = word;
        else if (line.length + 1 + word.length <= chars) line += ' ' + word;
        else {
          out.push(line);
          line = word;
        }
      }

      // An empty paragraph is a deliberate blank line, so keep it.
      out.push(line);
    }

    return out;
  }

  /** Pad each line so it sits where `align` says, for outputs with no alignment of their own. */
  function padForAlign(text, chars, align) {
    if (align === 'left' || !align) return text;

    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].slice(0, chars);
      var slack = chars - line.length;
      if (slack <= 0) continue;
      lines[i] = repeat(' ', align === 'center' ? Math.floor(slack / 2) : slack) + line;
    }
    return lines.join('\n');
  }

  /* ──────────────────────────────────────────────────────────────────────────
     Height
     ────────────────────────────────────────────────────────────────────────── */

  /**
   * Byte capacity of each QR version at error level H, which is what we print.
   * Index 0 is version 1 (21 modules); each version adds 4 modules.
   */
  var QR_CAPACITY_H = [
    7, 14, 24, 34, 44, 58, 64, 84, 98, 119,
    137, 155, 177, 194, 220, 250, 280, 310, 338, 382,
  ];

  /** Side of the QR symbol in modules, for the version that fits `data`. */
  function qrModules(data) {
    var bytes = unescape(encodeURIComponent(String(data))).length;
    for (var v = 0; v < QR_CAPACITY_H.length; v += 1) {
      if (bytes <= QR_CAPACITY_H[v]) return 21 + 4 * v;
    }
    return 21 + 4 * (QR_CAPACITY_H.length - 1);
  }

  function textHeight(text, size) {
    var lines = String(text).split('\n').length;
    var font = TEXT_SIZES[size] ? TEXT_SIZES[size].font : FONT_SIZE_NORMAL;
    return Math.round(lines * font * LINE_PITCH);
  }

  /**
   * How tall a compiled block prints, in dots.
   *
   * An estimate, not a measurement - only the printer knows for certain, and it
   * does not tell us. Text and images are close; a QR is derived from the
   * version its payload forces. Good enough to warn that a label will overrun,
   * which is the only thing it is used for.
   */
  function blockHeight(block) {
    if (block.type === 'text') return textHeight(block.text, block.size);
    if (block.type === 'bitmap') return block.height;
    if (block.type === 'qr') return qrModules(block.data) * block.moduleSize;
    if (block.type === 'barcode') {
      return block.height + (block.textPosition ? Math.round(FONT_SIZE_NORMAL * LINE_PITCH) : 0);
    }
    if (block.type === 'feed') return Math.round(block.lines * FONT_SIZE_NORMAL * LINE_PITCH);
    return 0;
  }

  /* ──────────────────────────────────────────────────────────────────────────
     Compile
     ────────────────────────────────────────────────────────────────────────── */

  /**
   * @param {object} state - the document
   * @param {object} images - map of block id to a prepared bitmap, from ReceiptLogo
   * @returns {{blocks: Array, chars: number, paper: object}}
   */
  function compile(state, images) {
    var paper = PAPER_SIZES[state.paper] || PAPER_SIZES[DEFAULT_PAPER];
    var chars = paper.chars;
    var out = [];
    var prepared = images || {};

    for (var i = 0; i < state.blocks.length; i += 1) {
      var block = state.blocks[i];

      if (block.type === 'text') {
        if (!String(block.text).length) continue;
        var size = TEXT_SIZES[block.size] ? block.size : 'normal';
        // A bigger font means fewer characters fit on the line, so the wrap
        // width has to shrink with it or the printer will break lines for us.
        var fit = Math.max(4, Math.floor(chars / TEXT_SIZES[size].scale));
        out.push({
          type: 'text',
          align: block.align || 'left',
          size: size,
          text: wrap(block.text, fit).join('\n'),
        });
      } else if (block.type === 'columns') {
        out.push({
          type: 'text',
          align: 'left',
          size: 'normal',
          text: twoCol(block.left || '', block.right || '', chars),
        });
      } else if (block.type === 'divider') {
        out.push({
          type: 'text',
          align: 'left',
          size: 'normal',
          text: repeat(block.char || '-', chars),
        });
      } else if (block.type === 'space') {
        var lines = Math.max(1, Math.min(10, Number(block.lines) || 1));
        out.push({ type: 'text', align: 'left', size: 'normal', text: repeat('\n', lines - 1) });
      } else if (block.type === 'image') {
        var bitmap = prepared[block.id];
        if (!bitmap) continue;
        out.push({
          type: 'bitmap',
          align: block.align || 'center',
          base64: bitmap.base64,
          dataUrl: bitmap.dataUrl,
          width: bitmap.width,
          height: bitmap.height,
          // Label mode composites from the prepared canvas rather than the data
          // URI, so it needs to find its way back to the source block.
          sourceId: block.id,
        });
      } else if (block.type === 'qr') {
        if (!String(block.data).length) continue;
        out.push({
          type: 'qr',
          align: block.align || 'center',
          data: block.data,
          moduleSize: Math.max(1, Math.min(16, Number(block.moduleSize) || 6)),
        });
      } else if (block.type === 'barcode') {
        if (!String(block.data).length) continue;
        out.push({
          type: 'barcode',
          align: block.align || 'center',
          data: block.data,
          height: Math.max(1, Math.min(255, Number(block.height) || 80)),
          textPosition: block.showText ? 2 : 0,
        });
      }
    }

    // Measure the content before any trailing feed is added, so the label
    // budget reflects what is actually on the sticker.
    var contentDots = 0;
    for (var h = 0; h < out.length; h += 1) contentDots += blockHeight(out[h]);

    if (out.length) {
      if (paper.sticker) {
        // Feeding a fixed number of lines is wrong on die-cut stock: it either
        // wastes a label or leaves the head mid-sticker. Ask the printer to
        // advance to the next label instead.
        if (state.labelFeed !== false) out.push({ type: 'formfeed' });
      } else {
        // Only feed if something was actually printed - a page with no content,
        // or one whose every block is still empty, must not spit blank paper.
        var feed = Math.max(0, Math.min(10, Number(state.feedLines) || 0));
        if (feed > 0) out.push({ type: 'feed', lines: feed });
      }
    }

    var budget = paper.heightMm ? Math.round(paper.heightMm * DOTS_PER_MM) : 0;

    // What one label costs end to end: the bitmap, which is always the full
    // label, plus the feed that carries the gap. Constant per label by
    // construction, which is what makes a sensorless advance repeatable.
    var pitchDots = paper.sticker
      ? Math.round((Number(state.labelPitchMm) || paper.heightMm) * DOTS_PER_MM)
      : 0;

    return {
      blocks: out,
      chars: chars,
      paper: paper,
      heightDots: contentDots,
      heightMm: contentDots / DOTS_PER_MM,
      budgetDots: budget,
      overflow: budget > 0 && contentDots > budget,
      pitchDots: pitchDots,
      // The bitmap occupies the whole label, so the remainder is pure gap.
      feedDots: pitchDots > budget ? pitchDots - budget : 0,
    };
  }

  /**
   * Flatten to plain lines, for bridges that only take text. Blocks the printer
   * would render natively become a readable stand-in rather than vanishing.
   */
  function flatten(blocks, chars) {
    var lines = [];

    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i];

      if (block.type === 'text') {
        lines = lines.concat(padForAlign(block.text, chars, block.align).split('\n'));
      } else if (block.type === 'qr') {
        lines.push(padForAlign('[QR] ' + block.data, chars, block.align));
      } else if (block.type === 'barcode') {
        lines.push(padForAlign(block.data, chars, block.align));
      } else if (block.type === 'feed') {
        for (var f = 0; f < block.lines; f += 1) lines.push('');
      }
    }

    return lines;
  }

  /** One-line description of a block, for the collapsed card in the editor. */
  function summarise(block) {
    if (block.type === 'text') {
      var text = String(block.text).replace(/\s+/g, ' ').trim();
      return text ? text.slice(0, 40) : 'Empty text';
    }
    if (block.type === 'columns') {
      return (block.left || '—') + '   ' + (block.right || '—');
    }
    if (block.type === 'divider') return repeat(block.char || '-', 12);
    if (block.type === 'space') {
      return block.lines + (Number(block.lines) === 1 ? ' blank line' : ' blank lines');
    }
    if (block.type === 'image') {
      return (block.source === 'custom' ? 'Picked image' : 'Default image') +
        ' at ' + block.widthPct + '%';
    }
    if (block.type === 'qr') return block.data ? String(block.data).slice(0, 40) : 'No content';
    if (block.type === 'barcode') {
      return block.data ? String(block.data).slice(0, 40) : 'No content';
    }
    return '';
  }

  function labelFor(type) {
    for (var i = 0; i < BLOCK_TYPES.length; i += 1) {
      if (BLOCK_TYPES[i].type === type) return BLOCK_TYPES[i].label;
    }
    return type;
  }

  global.Doc = {
    PAPER_SIZES: PAPER_SIZES,
    DEFAULT_PAPER: DEFAULT_PAPER,
    DOTS_PER_MM: DOTS_PER_MM,
    FONT_SIZE_NORMAL: FONT_SIZE_NORMAL,
    blockHeight: blockHeight,
    qrModules: qrModules,
    TEXT_SIZES: TEXT_SIZES,
    ALIGNMENTS: ALIGNMENTS,
    DIVIDER_CHARS: DIVIDER_CHARS,
    BLOCK_TYPES: BLOCK_TYPES,
    claimId: claimId,
    createBlock: createBlock,
    defaultState: defaultState,
    compile: compile,
    flatten: flatten,
    summarise: summarise,
    labelFor: labelFor,
    padForAlign: padForAlign,
    wrap: wrap,
  };
})(window);
