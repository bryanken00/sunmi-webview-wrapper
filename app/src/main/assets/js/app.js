/**
 * The block editor.
 *
 * The page starts blank. The palette appends blocks, each block card edits its
 * own fields in place, and every edit re-compiles the document and redraws the
 * preview. Dithering an image is the one expensive step, so prepared bitmaps
 * are cached against the inputs that actually change them.
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = 'sunmi.print.doc.v1';

  var state = Doc.defaultState();
  var compiled = null;

  /** blockId -> prepared bitmap, and blockId -> the key it was prepared from. */
  var images = {};
  var imageKeys = {};

  /** Ids of the block cards currently open for editing. */
  var expanded = {};

  var pendingImageBlock = null;
  var renderTimer = null;

  /** The rendered sticker, in label mode: what the preview shows and prints. */
  var labelBitmap = null;

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ── Persistence ──────────────────────────────────────────────────────── */

  function load() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;

      var saved = JSON.parse(raw);
      if (!saved || Object.prototype.toString.call(saved.blocks) !== '[object Array]') return;

      // Paper keys became strings when the sticker preset was added; a document
      // saved before that has a number, and both index the same entry.
      var paper = String(saved.paper);
      if (Doc.PAPER_SIZES[paper]) state.paper = paper;
      if (typeof saved.feedLines === 'number') state.feedLines = saved.feedLines;
      if (typeof saved.labelFeed === 'boolean') state.labelFeed = saved.labelFeed;
      if (typeof saved.labelPitchMm === 'number') state.labelPitchMm = saved.labelPitchMm;
      if (typeof saved.copies === 'number') state.copies = saved.copies;

      // Ids are handed back out this session, so the counter has to clear the
      // highest one restored or two blocks would share an image cache slot.
      for (var i = 0; i < saved.blocks.length; i += 1) {
        var block = saved.blocks[i];
        if (!block || !block.type) continue;
        block.id = Doc.claimId(block.id);
        state.blocks.push(block);
      }
    } catch (error) {
      if (global.console) console.error('Could not restore the saved page', error);
    }
  }

  function save() {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      // Most likely the quota, which a picked image can reach. The page still
      // works for this session; only the restore is lost.
      if (global.console) console.error('Could not save the page', error);
    }
  }

  /* ── Toast ────────────────────────────────────────────────────────────── */

  var toastTimer = null;

  function toast(message) {
    var node = $('toast');
    node.textContent = message;
    node.className = 'toast is-shown';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.className = 'toast';
    }, 2600);
  }

  /* ── Printer status ───────────────────────────────────────────────────── */

  var statusTries = 0;

  function refreshStatus() {
    var info = PrinterBridgeClient.describeChannel();
    var chip = $('statusChip');

    chip.textContent =
      info.channel === 'browser' ? 'No printer' : info.ready ? 'Ready' : 'Binding…';
    chip.className =
      'chip ' + (info.channel === 'browser' ? 'chip-warn' : info.ready ? 'chip-ok' : 'chip-idle');

    $('channelLabel').textContent = info.label;
    $('channelHint').textContent = info.hint;

    // Binding the AIDL service is asynchronous, so the bridge can be present
    // before the printer behind it is. Keep looking for a short while.
    statusTries += 1;
    if (!info.ready && statusTries < 12) setTimeout(refreshStatus, 1200);
  }

  /* ── Images ───────────────────────────────────────────────────────────── */

  function imageSource(block) {
    if (block.source === 'custom' && block.dataUrl) return block.dataUrl;
    return 'img/logo-default.png';
  }

  /**
   * Cache key for a prepared bitmap. The tail of the data URI stands in for the
   * image's identity, so swapping the picked image invalidates it without
   * needing a version counter that would not survive a reload.
   */
  function imageKey(block, dots) {
    var source = imageSource(block);
    var tag = block.source === 'custom' && block.dataUrl
      ? 'custom:' + source.length + ':' + source.slice(-32)
      : 'default';
    return tag + '|' + dots;
  }

  /** Dither every image block whose inputs changed. @returns {Promise<void>} */
  function ensureImages() {
    var paper = Doc.PAPER_SIZES[state.paper];
    var jobs = [];
    var live = {};

    for (var i = 0; i < state.blocks.length; i += 1) {
      var block = state.blocks[i];
      if (block.type !== 'image') continue;

      live[block.id] = true;
      var dots = Math.round((paper.dots * (Number(block.widthPct) || 70)) / 100);
      var key = imageKey(block, dots);
      if (imageKeys[block.id] === key && images[block.id]) continue;

      jobs.push(
        (function (target, wanted) {
          return ReceiptLogo.prepareLogo(imageSource(target), dots).then(
            function (prepared) {
              images[target.id] = prepared;
              imageKeys[target.id] = wanted;
            },
            function (error) {
              delete images[target.id];
              delete imageKeys[target.id];
              if (global.console) console.error('Could not prepare an image', error);
            }
          );
        })(block, key)
      );
    }

    // Drop bitmaps for blocks that are gone, so a long session cannot grow
    // unbounded as images are added and removed.
    for (var id in images) {
      if (!live[id]) {
        delete images[id];
        delete imageKeys[id];
      }
    }

    return jobs.length ? Promise.all(jobs).then(function () {}) : Promise.resolve();
  }

  /** Shrink an imported photo before it is kept - the printer needs far less. */
  function downscale(dataUrl, maxWidth) {
    return new Promise(function (resolve) {
      var image = new Image();
      image.onload = function () {
        if (image.width <= maxWidth) {
          resolve(dataUrl);
          return;
        }
        var canvas = document.createElement('canvas');
        canvas.width = maxWidth;
        canvas.height = Math.max(1, Math.round((image.height * maxWidth) / image.width));
        var context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = function () {
        resolve(dataUrl);
      };
      image.src = dataUrl;
    });
  }

  /* ── Field builders ───────────────────────────────────────────────────── */

  function fieldWrap(labelText) {
    var label = el('label', 'field');
    if (labelText) label.appendChild(el('span', null, labelText));
    return label;
  }

  function textField(labelText, value, placeholder, onChange) {
    var label = fieldWrap(labelText);
    var input = el('input');
    input.type = 'text';
    input.value = value || '';
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener('input', function () {
      onChange(input.value);
    }, false);
    label.appendChild(input);
    return label;
  }

  function textAreaField(labelText, value, placeholder, onChange) {
    var label = fieldWrap(labelText);
    var input = el('textarea');
    input.rows = 3;
    input.value = value || '';
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener('input', function () {
      onChange(input.value);
    }, false);
    label.appendChild(input);
    return label;
  }

  function numberField(labelText, value, min, max, onChange) {
    var label = fieldWrap(labelText);
    var input = el('input');
    input.type = 'number';
    input.value = value;
    input.min = min;
    input.max = max;
    input.step = 1;
    input.addEventListener('input', function () {
      onChange(Number(input.value) || 0);
    }, false);
    label.appendChild(input);
    return label;
  }

  /** @param {Array<{value, label}>} options */
  function segmentedField(labelText, options, value, onChange) {
    var wrap = el('div', 'field');
    if (labelText) wrap.appendChild(el('span', null, labelText));

    var group = el('div', 'segmented');
    var buttons = [];

    var paint = function (current) {
      for (var i = 0; i < buttons.length; i += 1) {
        buttons[i].className = buttons[i].getAttribute('data-value') === String(current)
          ? 'is-active'
          : '';
      }
    };

    for (var i = 0; i < options.length; i += 1) {
      (function (option) {
        var button = el('button', null, option.label);
        button.type = 'button';
        button.setAttribute('data-value', String(option.value));
        button.addEventListener('click', function () {
          paint(option.value);
          onChange(option.value);
        }, false);
        buttons.push(button);
        group.appendChild(button);
      })(options[i]);
    }

    paint(value);
    wrap.appendChild(group);
    return wrap;
  }

  function switchField(title, subtitle, value, onChange) {
    var label = el('label', 'switch');
    var text = el('span');
    text.appendChild(el('strong', null, title));
    if (subtitle) text.appendChild(el('small', null, subtitle));

    var input = el('input');
    input.type = 'checkbox';
    input.checked = !!value;
    input.addEventListener('change', function () {
      onChange(input.checked);
    }, false);

    label.appendChild(text);
    label.appendChild(input);
    label.appendChild(el('i'));
    return label;
  }

  function rangeField(labelText, value, min, max, step, format, onChange) {
    var wrap = el('div', 'field');
    var span = el('span', null, labelText + ' ');
    var readout = el('b', null, format(value));
    span.appendChild(readout);
    wrap.appendChild(span);

    var input = el('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    input.addEventListener('input', function () {
      var next = Number(input.value);
      readout.textContent = format(next);
      onChange(next);
    }, false);

    wrap.appendChild(input);
    return wrap;
  }

  var ALIGN_OPTIONS = [
    { value: 'left', label: 'Left' },
    { value: 'center', label: 'Centre' },
    { value: 'right', label: 'Right' },
  ];

  /* ── Block editors ────────────────────────────────────────────────────── */

  function buildEditor(block) {
    var body = el('div', 'block-body');
    var touch = function () {
      changed();
      refreshSummary(block);
    };

    if (block.type === 'text') {
      body.appendChild(
        textAreaField('Text', block.text, 'Anything you want printed', function (value) {
          block.text = value;
          touch();
        })
      );
      body.appendChild(
        segmentedField('Size', [
          { value: 'normal', label: 'Normal' },
          { value: 'large', label: 'Large' },
          { value: 'xlarge', label: 'Huge' },
        ], block.size, function (value) {
          block.size = value;
          touch();
        })
      );
      body.appendChild(
        segmentedField('Align', ALIGN_OPTIONS, block.align, function (value) {
          block.align = value;
          touch();
        })
      );
    } else if (block.type === 'columns') {
      body.appendChild(
        textField('Left', block.left, 'Label', function (value) {
          block.left = value;
          touch();
        })
      );
      body.appendChild(
        textField('Right', block.right, 'Value', function (value) {
          block.right = value;
          touch();
        })
      );
      body.appendChild(
        el('p', 'hint', 'Left text and right text on one line, pushed to the paper edges.')
      );
    } else if (block.type === 'divider') {
      var chars = [];
      for (var i = 0; i < Doc.DIVIDER_CHARS.length; i += 1) {
        chars.push({ value: Doc.DIVIDER_CHARS[i], label: Doc.DIVIDER_CHARS[i] });
      }
      body.appendChild(
        segmentedField('Character', chars, block.char, function (value) {
          block.char = value;
          touch();
        })
      );
    } else if (block.type === 'space') {
      body.appendChild(
        numberField('Blank lines', block.lines, 1, 10, function (value) {
          block.lines = Math.max(1, Math.min(10, value));
          touch();
        })
      );
    } else if (block.type === 'image') {
      body.appendChild(buildImagePicker(block, touch));
      body.appendChild(
        rangeField('Width', block.widthPct, 20, 100, 5, function (v) {
          return v + '%';
        }, function (value) {
          block.widthPct = value;
          touch();
        })
      );
      body.appendChild(
        segmentedField('Align', ALIGN_OPTIONS, block.align, function (value) {
          block.align = value;
          touch();
        })
      );
    } else if (block.type === 'qr') {
      body.appendChild(
        textAreaField('Content', block.data, 'Link, text, anything', function (value) {
          block.data = value;
          touch();
        })
      );
      body.appendChild(
        rangeField('Module size', block.moduleSize, 1, 16, 1, function (v) {
          return String(v);
        }, function (value) {
          block.moduleSize = value;
          touch();
        })
      );
      body.appendChild(
        segmentedField('Align', ALIGN_OPTIONS, block.align, function (value) {
          block.align = value;
          touch();
        })
      );
    } else if (block.type === 'barcode') {
      body.appendChild(
        textField('Content', block.data, 'CODE128 - any characters', function (value) {
          block.data = value;
          touch();
        })
      );
      body.appendChild(
        rangeField('Height', block.height, 20, 255, 5, function (v) {
          return v + ' dots';
        }, function (value) {
          block.height = value;
          touch();
        })
      );
      body.appendChild(
        switchField('Print the text', 'Under the bars', block.showText, function (value) {
          block.showText = value;
          touch();
        })
      );
      body.appendChild(
        segmentedField('Align', ALIGN_OPTIONS, block.align, function (value) {
          block.align = value;
          touch();
        })
      );
    }

    return body;
  }

  function buildImagePicker(block, touch) {
    var wrap = el('div');
    var picker = el('div', 'picker');

    var defaultTile = el('button', 'pick');
    defaultTile.type = 'button';
    defaultTile.setAttribute('data-source', 'default');
    var defaultImg = el('img');
    defaultImg.src = 'img/logo-default.png';
    defaultImg.alt = 'Bundled default image';
    defaultTile.appendChild(defaultImg);
    defaultTile.appendChild(el('span', null, 'Default'));

    var customTile = el('button', 'pick');
    customTile.type = 'button';
    customTile.setAttribute('data-source', 'custom');
    var slot = el('div', 'pick-empty');
    var customImg = el('img');
    customImg.alt = 'Chosen image';
    customImg.hidden = true;
    slot.appendChild(customImg);
    slot.appendChild(el('span', 'pick-plus', '+'));
    customTile.appendChild(slot);
    customTile.appendChild(el('span', null, 'From device'));

    var paint = function () {
      defaultTile.className = block.source === 'default' ? 'pick is-active' : 'pick';
      customTile.className = block.source === 'custom' ? 'pick is-active' : 'pick';
      if (block.dataUrl) {
        customImg.src = block.dataUrl;
        customImg.hidden = false;
      } else {
        customImg.hidden = true;
      }
    };

    defaultTile.addEventListener('click', function () {
      block.source = 'default';
      paint();
      touch();
    }, false);

    customTile.addEventListener('click', function () {
      // Picking "from device" with nothing chosen yet opens the picker rather
      // than selecting an empty image.
      if (!block.dataUrl) {
        openImagePicker(block, paint, touch);
        return;
      }
      block.source = 'custom';
      paint();
      touch();
    }, false);

    picker.appendChild(defaultTile);
    picker.appendChild(customTile);
    wrap.appendChild(picker);

    var choose = el('button', 'btn btn-ghost btn-block', 'Choose image from device');
    choose.type = 'button';
    choose.addEventListener('click', function () {
      openImagePicker(block, paint, touch);
    }, false);
    wrap.appendChild(choose);

    paint();
    return wrap;
  }

  function openImagePicker(block, paint, touch) {
    pendingImageBlock = { block: block, paint: paint, touch: touch };
    $('imageFile').click();
  }

  /* ── Block list ───────────────────────────────────────────────────────── */

  function indexOfBlock(id) {
    for (var i = 0; i < state.blocks.length; i += 1) {
      if (state.blocks[i].id === id) return i;
    }
    return -1;
  }

  function refreshSummary(block) {
    var card = $('blockList').querySelector('[data-id="' + block.id + '"]');
    if (!card) return;
    var summary = card.querySelector('.block-summary');
    if (summary) summary.textContent = Doc.summarise(block);
  }

  function iconFor(type) {
    for (var i = 0; i < Doc.BLOCK_TYPES.length; i += 1) {
      if (Doc.BLOCK_TYPES[i].type === type) return Doc.BLOCK_TYPES[i].icon;
    }
    return '?';
  }

  function buildCard(block, index) {
    var card = el('div', expanded[block.id] ? 'block is-open' : 'block');
    card.setAttribute('data-id', String(block.id));

    var head = el('div', 'block-head');
    head.appendChild(el('span', 'block-icon', iconFor(block.type)));

    var title = el('div', 'block-title');
    title.appendChild(el('strong', null, Doc.labelFor(block.type)));
    title.appendChild(el('small', 'block-summary', Doc.summarise(block)));
    head.appendChild(title);

    // The whole title area toggles, so there is a large target on a small screen.
    var toggle = function () {
      if (expanded[block.id]) delete expanded[block.id];
      else expanded[block.id] = true;
      renderBlocks();
    };
    head.querySelector('.block-icon').addEventListener('click', toggle, false);
    title.addEventListener('click', toggle, false);

    var tools = el('div', 'block-tools');

    var up = el('button', 'icon-btn', '↑');
    up.type = 'button';
    up.disabled = index === 0;
    up.addEventListener('click', function () {
      move(block.id, -1);
    }, false);

    var down = el('button', 'icon-btn', '↓');
    down.type = 'button';
    down.disabled = index === state.blocks.length - 1;
    down.addEventListener('click', function () {
      move(block.id, 1);
    }, false);

    var remove = el('button', 'icon-btn icon-danger', '×');
    remove.type = 'button';
    remove.addEventListener('click', function () {
      var at = indexOfBlock(block.id);
      if (at < 0) return;
      state.blocks.splice(at, 1);
      delete expanded[block.id];
      renderBlocks();
      changed();
    }, false);

    tools.appendChild(up);
    tools.appendChild(down);
    tools.appendChild(remove);
    head.appendChild(tools);

    card.appendChild(head);
    if (expanded[block.id]) card.appendChild(buildEditor(block));

    return card;
  }

  function move(id, direction) {
    var at = indexOfBlock(id);
    var to = at + direction;
    if (at < 0 || to < 0 || to >= state.blocks.length) return;

    var block = state.blocks[at];
    state.blocks.splice(at, 1);
    state.blocks.splice(to, 0, block);
    renderBlocks();
    changed();
  }

  function renderBlocks() {
    var list = $('blockList');
    list.innerHTML = '';

    for (var i = 0; i < state.blocks.length; i += 1) {
      list.appendChild(buildCard(state.blocks[i], i));
    }

    $('emptyState').hidden = state.blocks.length > 0;
  }

  function buildPalette() {
    var palette = $('palette');

    for (var i = 0; i < Doc.BLOCK_TYPES.length; i += 1) {
      (function (entry) {
        var button = el('button', 'palette-btn');
        button.type = 'button';
        button.appendChild(el('span', 'palette-icon', entry.icon));
        button.appendChild(el('span', 'palette-label', entry.label));
        button.addEventListener('click', function () {
          var block = Doc.createBlock(entry.type);
          state.blocks.push(block);
          // Open the new block straight away - it is empty, so it always needs
          // editing before it prints anything.
          expanded[block.id] = true;
          renderBlocks();
          changed();

          var card = $('blockList').querySelector('[data-id="' + block.id + '"]');
          if (card && card.scrollIntoView) card.scrollIntoView();
          var first = card && card.querySelector('textarea, input[type="text"]');
          if (first) first.focus();
        }, false);
        palette.appendChild(button);
      })(Doc.BLOCK_TYPES[i]);
    }
  }

  /* ── Preview ──────────────────────────────────────────────────────────── */

  /** Padding on .paper, which the ch-based width and height have to clear. */
  var PREVIEW_PAD_PX = 16;
  var PREVIEW_PAD_TOP_PX = 10;

  function renderPreview() {
    compiled = Doc.compile(state, images);

    var paper = $('paperPreview');
    // Width in `ch` of the paper's own monospace font, so the preview is
    // exactly `chars` columns wide instead of a guess at the glyph advance.
    paper.style.width = 'calc(' + compiled.chars + 'ch + ' + PREVIEW_PAD_PX + 'px)';

    paper.className = compiled.paper.sticker ? 'paper is-label' : 'paper';

    if (!compiled.blocks.length) {
      paper.innerHTML = '';
      paper.appendChild(el('p', 'paper-empty', 'Nothing to print yet'));
      $('previewMeta').textContent = '';
      $('labelGauge').hidden = true;
      labelBitmap = null;
      return;
    }

    if (compiled.paper.sticker) {
      // The preview IS the bitmap that gets printed, at the head's exact dot
      // pitch - so this is not a representation of the sticker, it is the
      // sticker. Anything past the bottom edge is clipped here exactly as it
      // will be clipped on paper.
      labelBitmap = Label.render(compiled, images);

      paper.innerHTML = '';
      var bitmap = el('img', 'label-bitmap');
      bitmap.src = labelBitmap.dataUrl;
      bitmap.alt = 'The sticker as it will print';
      bitmap.style.width = compiled.chars + 'ch';
      paper.appendChild(bitmap);

      renderLabelGauge();
      $('previewMeta').textContent =
        compiled.paper.widthMm + ' × ' + compiled.paper.heightMm + ' mm · ' +
        labelBitmap.width + ' × ' + labelBitmap.height + ' dots · pitch ' +
        (compiled.pitchDots / Doc.DOTS_PER_MM).toFixed(3) + ' mm (' +
        compiled.pitchDots + ' dots, feeding ' + compiled.feedDots + ')';
      return;
    }

    labelBitmap = null;
    paper.innerHTML = PrinterBridgeClient.blocksToHtml(compiled, false);

    // The dithered bitmaps are sized in printer dots; show each at the same
    // share of the paper it will actually occupy. Expressed in `ch` rather than
    // pixels because this runs while the Preview panel may still be hidden,
    // where measuring the paper would just return zero.
    var bitmaps = [];
    for (var i = 0; i < compiled.blocks.length; i += 1) {
      if (compiled.blocks[i].type === 'bitmap') bitmaps.push(compiled.blocks[i]);
    }
    var nodes = paper.querySelectorAll('img.r-img');
    for (var n = 0; n < nodes.length && n < bitmaps.length; n += 1) {
      var share = bitmaps[n].width / compiled.paper.dots;
      nodes[n].style.width = (share * compiled.chars).toFixed(2) + 'ch';
    }

    $('labelGauge').hidden = true;
    var lines = Doc.flatten(compiled.blocks, compiled.chars).length;
    $('previewMeta').textContent =
      compiled.paper.widthMm + 'mm · ' + compiled.chars + ' columns · about ' +
      lines + (lines === 1 ? ' line' : ' lines');
  }

  /**
   * How much of the sticker the content uses.
   *
   * In label mode this is measured off the rendered bitmap rather than
   * estimated from font metrics, so it is exact — and overrun means the content
   * is *clipped* at the label edge, not pushed onto the next sticker, because
   * the bitmap is a fixed size.
   */
  function renderLabelGauge() {
    var gauge = $('labelGauge');
    var usedMm = labelBitmap.contentDots / Doc.DOTS_PER_MM;
    var budget = compiled.paper.heightMm;
    var percent = Math.min(100, Math.round((usedMm / budget) * 100));

    gauge.hidden = false;
    gauge.className = labelBitmap.overflow ? 'gauge is-over' : 'gauge';
    $('gaugeFill').style.width = percent + '%';
    $('gaugeText').textContent = labelBitmap.overflow
      ? 'Too tall — ' + usedMm.toFixed(1) + ' mm of content on a ' + budget +
        ' mm sticker. Everything past the edge is cut off.'
      : usedMm.toFixed(1) + ' of ' + budget + ' mm used';
  }

  /** Every mutation funnels through here: persist, re-dither if needed, redraw. */
  function changed() {
    save();
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(function () {
      ensureImages().then(renderPreview);
    }, 120);
  }

  /* ── Tabs and setup ───────────────────────────────────────────────────── */

  var activateTab;

  function bindTabs() {
    var tabs = $('tabs').querySelectorAll('.tab');
    var panels = document.querySelectorAll('.panel');

    activateTab = function (name) {
      for (var i = 0; i < tabs.length; i += 1) {
        tabs[i].className = tabs[i].getAttribute('data-tab') === name ? 'tab is-active' : 'tab';
      }
      for (var p = 0; p < panels.length; p += 1) {
        panels[p].className =
          panels[p].getAttribute('data-panel') === name ? 'panel is-active' : 'panel';
      }
      document.querySelector('.scroll').scrollTop = 0;
    };

    for (var i = 0; i < tabs.length; i += 1) {
      (function (tab) {
        tab.addEventListener('click', function () {
          activateTab(tab.getAttribute('data-tab'));
        }, false);
      })(tabs[i]);
    }
  }

  function bindSetup() {
    var buttons = $('paperSeg').querySelectorAll('button');

    var paint = function () {
      var paper = Doc.PAPER_SIZES[state.paper];

      for (var i = 0; i < buttons.length; i += 1) {
        buttons[i].className =
          buttons[i].getAttribute('data-paper') === state.paper ? 'is-active' : '';
      }

      // The stock decides how a job ends: roll feeds lines, die-cut advances a
      // measured distance, so only one of the two controls is ever relevant.
      $('rollFeedField').hidden = !!paper.sticker;
      $('labelCard').hidden = !paper.sticker;

      $('paperHint').textContent = paper.sticker
        ? paper.printableMm + ' mm printable of ' + paper.widthMm + ' mm wide · ' +
          paper.chars + ' columns · ' + paper.heightMm + ' mm tall. ' +
          'The head is ' + paper.dots + ' dots, so ' +
          (paper.widthMm - paper.printableMm) + ' mm of the sticker cannot be reached.'
        : paper.printableMm + ' mm printable of ' + paper.widthMm + ' mm wide · ' +
          paper.chars + ' columns · continuous.';
    };

    for (var i = 0; i < buttons.length; i += 1) {
      (function (button) {
        button.addEventListener('click', function () {
          state.paper = button.getAttribute('data-paper');
          paint();
          changed();
        }, false);
      })(buttons[i]);
    }
    paint();

    var feed = $('feedLines');
    feed.value = state.feedLines;
    feed.addEventListener('input', function () {
      state.feedLines = Math.max(0, Math.min(10, Number(feed.value) || 0));
      changed();
    }, false);

    var labelFeed = $('labelFeed');
    labelFeed.checked = state.labelFeed !== false;
    labelFeed.addEventListener('change', function () {
      state.labelFeed = labelFeed.checked;
      changed();
    }, false);

    bindPitch();

    var copies = $('copies');
    copies.value = state.copies;
    copies.addEventListener('input', function () {
      state.copies = Math.max(1, Math.min(50, Number(copies.value) || 1));
      changed();
    }, false);

    $('calibrateBtn').addEventListener('click', printCalibration, false);

    $('recheckBtn').addEventListener('click', function () {
      statusTries = 0;
      refreshStatus();
      toast('Checking the printer…');
    }, false);

    $('clearBtn').addEventListener('click', function () {
      if (!state.blocks.length) {
        toast('The page is already blank');
        return;
      }
      if (!global.confirm('Remove every block from the page?')) return;

      state.blocks = [];
      expanded = {};
      images = {};
      imageKeys = {};
      renderBlocks();
      changed();
      activateTab('design');
      toast('Page cleared');
    }, false);
  }

  /**
   * The pitch slider moves in half millimetres, which is enough to get close;
   * the nudge buttons then move it one dot (0.125 mm) at a time, which is the
   * finest the printer can actually feed.
   */
  function bindPitch() {
    var slider = $('labelPitch');
    var oneDot = 1 / Doc.DOTS_PER_MM;

    var paint = function () {
      $('pitchValue').textContent = state.labelPitchMm.toFixed(3) + ' mm';
      $('pitchDots').textContent = Math.round(state.labelPitchMm * Doc.DOTS_PER_MM) + ' dots';
      slider.value = state.labelPitchMm;
    };

    var set = function (mm) {
      // Below the label height there is nothing left to feed, and the next
      // sticker would start under the head.
      var floor = Doc.PAPER_SIZES['50x30'].heightMm;
      state.labelPitchMm = Math.max(floor, Math.min(60, Math.round(mm * Doc.DOTS_PER_MM) / Doc.DOTS_PER_MM));
      paint();
      changed();
    };

    slider.addEventListener('input', function () {
      set(Number(slider.value));
    }, false);

    $('pitchDown').addEventListener('click', function () {
      set(state.labelPitchMm - oneDot);
    }, false);

    $('pitchUp').addEventListener('click', function () {
      set(state.labelPitchMm + oneDot);
    }, false);

    paint();
  }

  /** Send the same bitmap `copies` times, one label per pass. */
  function printCopies(target, bitmap, copies) {
    var run = Promise.resolve({ channel: 'none' });

    for (var i = 0; i < copies; i += 1) {
      run = run.then(function () {
        return PrinterBridgeClient.print(target, bitmap);
      });
    }

    return run;
  }

  function printCalibration() {
    var paper = Doc.PAPER_SIZES['50x30'];
    var bitmap = Label.renderCalibration(paper, state.labelPitchMm);

    // A minimal document that carries the label geometry; the bitmap is the
    // calibration pattern rather than anything the user composed.
    var target = Doc.compile(
      {
        paper: '50x30',
        labelPitchMm: state.labelPitchMm,
        labelFeed: state.labelFeed,
        feedLines: 0,
        blocks: [{ id: -1, type: 'text', text: '.', align: 'left', size: 'normal' }],
      },
      {}
    );

    var button = $('calibrateBtn');
    button.disabled = true;
    button.textContent = 'Printing…';

    printCopies(target, bitmap, 3)
      .then(function (result) {
        toast(
          result.channel === 'browser'
            ? 'No printer bridge - opened the print dialog'
            : 'Printed three calibration stickers'
        );
      })
      .catch(function (error) {
        if (global.console) console.error('Calibration print failed', error);
        toast('Calibration print failed');
      })
      .then(function () {
        button.disabled = false;
        button.textContent = 'Print calibration strip';
      });
  }

  function bindActions() {
    $('previewBtn').addEventListener('click', function () {
      activateTab('preview');
    }, false);

    $('printBtn').addEventListener('click', function () {
      if (!state.blocks.length) {
        toast('Add a block before printing');
        return;
      }

      var button = $('printBtn');
      button.disabled = true;
      button.textContent = 'Printing…';

      // Re-compile first: an image may still be dithering when the button is hit.
      ensureImages()
        .then(function () {
          renderPreview();
          var copies = compiled.paper.sticker ? state.copies : 1;
          return printCopies(compiled, labelBitmap, copies);
        })
        .then(function (result) {
          var copies = compiled.paper.sticker ? state.copies : 1;
          toast(
            result.channel === 'browser'
              ? 'No printer bridge - opened the print dialog'
              : copies > 1 ? 'Sent ' + copies + ' labels to the printer' : 'Sent to the printer'
          );
        })
        .catch(function (error) {
          if (global.console) console.error('Print failed', error);
          toast(
            error && error.message === 'Nothing to print'
              ? 'Every block is empty - nothing to print'
              : 'Print failed - see logcat for details'
          );
        })
        .then(function () {
          button.disabled = false;
          button.textContent = 'Print';
          refreshStatus();
        });
    }, false);

    $('statusChip').addEventListener('click', function () {
      statusTries = 0;
      refreshStatus();
    }, false);

    // One file input serves every image block; the pending block says where the
    // result belongs.
    var file = $('imageFile');
    file.addEventListener('change', function () {
      var chosen = file.files && file.files[0];
      var target = pendingImageBlock;
      pendingImageBlock = null;
      // Let the same file be picked again next time.
      file.value = '';

      if (!chosen || !target) return;

      ReceiptLogo.readFileAsDataUrl(chosen)
        .then(function (dataUrl) {
          return downscale(dataUrl, 800);
        })
        .then(function (dataUrl) {
          target.block.dataUrl = dataUrl;
          target.block.source = 'custom';
          target.paint();
          target.touch();
          toast('Image added');
        })
        .catch(function (error) {
          if (global.console) console.error('Could not read the picked image', error);
          toast('Could not read that image');
        });
    }, false);
  }

  /* ── Start ────────────────────────────────────────────────────────────── */

  function start() {
    load();
    bindTabs();
    bindSetup();
    bindActions();
    buildPalette();
    renderBlocks();
    refreshStatus();

    ensureImages().then(renderPreview);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, false);
  } else {
    start();
  }
})(window);
