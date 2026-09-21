/**
 * Turns a normal colour image into something a thermal printer can render.
 *
 * Ported from the React app's `src/utils/receiptLogo.js` so the standalone APK
 * carries no build step — same pipeline, written for the older WebView that
 * ships on Sunmi hardware (no optional chaining, no spread, no flatMap).
 *
 * A receipt printer has no greys: each dot is burned or it is not. The pipeline
 * is flatten onto white, trim the dead margin, scale to the head's exact dot
 * width, then reduce to pure black and white.
 *
 * That last step has two answers and the caller picks. A photograph needs
 * Floyd-Steinberg dithering, which keeps light tones visible as a stipple
 * instead of dropping them. A logo needs a threshold: its strokes are already
 * solid, and a stipple laid over them fuses into grey mush once the head's heat
 * spreads between neighbouring dots.
 */
(function (global) {
  "use strict";

  /** Luminance at or above this counts as blank paper when trimming margins. */
  var BLANK_THRESHOLD = 245;

  /**
   * Cut-off for the line-art path, where the image is thresholded rather than
   * dithered. Above the midpoint on purpose: scaling a logo down to the head's
   * dot width blends its strokes toward white, and at 128 the thin ones drop
   * out. 160 keeps them.
   */
  var LINE_ART_THRESHOLD = 160;

  /** Rec. 601 luma - matches how the eye weights the channels. */
  function luminance(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () {
        resolve(image);
      };
      image.onerror = function () {
        reject(new Error("Could not load image"));
      };
      image.src = src;
    });
  }

  /**
   * Composite onto white and find the bounding box of non-blank pixels, so the
   * printer does not feed centimetres of empty paper around the artwork.
   */
  function flattenAndMeasure(image) {
    var canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;

    var context = canvas.getContext("2d", { willReadFrequently: true });
    // Transparent pixels would otherwise read as black and print as a solid slab.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);

    var data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    var minX = canvas.width;
    var minY = canvas.height;
    var maxX = -1;
    var maxY = -1;

    for (var y = 0; y < canvas.height; y += 1) {
      for (var x = 0; x < canvas.width; x += 1) {
        var i = (y * canvas.width + x) * 4;
        if (luminance(data[i], data[i + 1], data[i + 2]) >= BLANK_THRESHOLD) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    // An entirely blank image has no box - fall back to the whole canvas.
    var box =
      maxX < 0
        ? { x: 0, y: 0, w: canvas.width, h: canvas.height }
        : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };

    return { canvas: canvas, box: box };
  }

  /**
   * Floyd-Steinberg error diffusion, in place over a grayscale buffer.
   * Pushing each pixel's rounding error onto its neighbours is what keeps light
   * tones visible as a stipple instead of dropping out entirely.
   */
  function dither(gray, width, height) {
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        var i = y * width + x;
        var before = gray[i];
        var after = before < 128 ? 0 : 255;
        gray[i] = after;

        var error = before - after;
        if (x + 1 < width) gray[i + 1] += (error * 7) / 16;
        if (y + 1 < height) {
          var below = i + width;
          if (x > 0) gray[below - 1] += (error * 3) / 16;
          gray[below] += (error * 5) / 16;
          if (x + 1 < width) gray[below + 1] += (error * 1) / 16;
        }
      }
    }
  }

  /**
   * Prepare an image for the printer.
   *
   * @param {string} src - Image URL or data: URI
   * @param {number} dotWidth - Target width in printer dots (<= head width)
   * @param {object|number} [options] - `maxHeightRatio` caps the height as a
   *   multiple of the head width, so a tall image cannot run away with the
   *   paper. `dither` picks the pipeline: true diffuses the error into a
   *   stipple, which is right for a photograph and wrong for a logo, because at
   *   203dpi the head's heat spreads between neighbouring dots and a stipple
   *   fuses into grey mush. False thresholds instead, keeping edges hard. A
   *   number is accepted in place of the object as the old maxHeightRatio.
   * @returns {Promise<{dataUrl: string, base64: string, width: number, height: number}>}
   */
  function prepareLogo(src, dotWidth, options) {
    var settings = typeof options === "number" ? { maxHeightRatio: options } : options || {};
    var ratio =
      typeof settings.maxHeightRatio === "number" ? settings.maxHeightRatio : 0.75;
    var useDither = settings.dither === true;

    return loadImage(src).then(function (image) {
      var measured = flattenAndMeasure(image);
      var source = measured.canvas;
      var box = measured.box;

      var scale = dotWidth / box.w;
      var targetWidth = Math.max(8, Math.round(dotWidth));
      var targetHeight = Math.max(
        8,
        Math.min(Math.round(box.h * scale), Math.round(dotWidth * ratio))
      );

      var output = document.createElement("canvas");
      output.width = targetWidth;
      output.height = targetHeight;

      var context = output.getContext("2d", { willReadFrequently: true });
      context.fillStyle = "#fff";
      context.fillRect(0, 0, targetWidth, targetHeight);
      context.drawImage(
        source,
        box.x,
        box.y,
        box.w,
        box.h,
        0,
        0,
        targetWidth,
        targetHeight
      );

      var imageData = context.getImageData(0, 0, targetWidth, targetHeight);
      var data = imageData.data;

      // Float buffer, not Uint8 - diffused error needs to accumulate fractionally.
      var gray = new Float32Array(targetWidth * targetHeight);
      for (var i = 0; i < gray.length; i += 1) {
        var p = i * 4;
        gray[i] = luminance(data[p], data[p + 1], data[p + 2]);
      }

      var cut = LINE_ART_THRESHOLD;
      if (useDither) {
        dither(gray, targetWidth, targetHeight);
        // The dither already decided each pixel; anything but the midpoint here
        // would undo half of its work.
        cut = 128;
      }

      for (var j = 0; j < gray.length; j += 1) {
        var q = j * 4;
        var value = gray[j] < cut ? 0 : 255;
        data[q] = value;
        data[q + 1] = value;
        data[q + 2] = value;
        data[q + 3] = 255;
      }
      context.putImageData(imageData, 0, 0);

      var dataUrl = output.toDataURL("image/png");
      return {
        dataUrl: dataUrl,
        base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
        width: targetWidth,
        height: targetHeight,
        // The canvas itself, so label mode can composite it into the sticker
        // bitmap synchronously - drawImage takes a canvas as readily as an
        // <img>, and this avoids a second decode of what we just produced.
        image: output,
      };
    });
  }

  /**
   * Read a picked File as a data: URI.
   *
   * Data URIs do not taint a canvas, which matters because the dither pipeline
   * above has to call getImageData() on whatever the user picks.
   *
   * @param {File} file
   * @returns {Promise<string>}
   */
  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result));
      };
      reader.onerror = function () {
        reject(new Error("Could not read that file"));
      };
      reader.readAsDataURL(file);
    });
  }

  global.ReceiptLogo = {
    prepareLogo: prepareLogo,
    readFileAsDataUrl: readFileAsDataUrl,
  };
})(window);
