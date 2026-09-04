# Sunmi Print Composer

A standalone Android app for Sunmi handhelds. It opens on a **blank page** and
you build whatever you want to print out of blocks — text, images, QR codes,
barcodes, rules, spacing — then send it to the **built-in printer**.

Nothing in it is receipt-shaped. A receipt is just one arrangement of these
blocks, and so is a label, a ticket, a queue number, a shelf tag or a note.

There are two halves:

- the **composer UI**, which ships inside the APK (`app/src/main/assets`), so
  the device needs no server and no network;
- a **native bridge** that binds the Sunmi print service and exposes it to that
  UI as `window.AndroidPrinter`.

A web page cannot reach the printer on its own. The Sunmi internal printer is
not a USB device — it is only reachable through the AIDL service
`woyou.aidlservice.jiuiv5`, the virtual `InnerPrinter` Bluetooth device, or a JS
bridge injected by a native container. This app is that container.

The same bridge still works for the React app in this repo: build with
`-PappUrl=...` and the WebView loads that URL instead of the bundled UI.
`src/utils/thermalPrinter.js` already probes for `window.AndroidPrinter`.

---

## Build

Requires Android Studio (or a JDK 17 + Android SDK with `ANDROID_HOME` set).
Pinned to AGP 8.1.4 / Kotlin 1.9.24 / Gradle 8.0.2 — verified building on that
combination.

```bash
cd sunmi-webview-wrapper
gradle wrapper --gradle-version 8.0.2   # first time only, generates ./gradlew
./gradlew assembleRelease
```

The APK lands at `app/build/outputs/apk/release/app-release.apk`, and a copy is
kept at `public/downloads/sunmi-printer-wrapper.apk` so the React app can serve
it. Use `assembleDebug` while iterating.

Release builds are signed with the debug key so the APK installs without setting
up a keystore. Generate a real keystore before shipping to production devices.

### Pointing it at a server instead

```bash
./gradlew assembleRelease -PappUrl=http://192.168.1.20:5173
```

Empty (the default) means "load the bundled composer". Anything else is loaded
as a URL — your deployed app, or a Vite dev server on the LAN.

## Install

```bash
adb install -r app/build/outputs/apk/release/app-release.apk
adb shell am start -n com.dgs.sunmiwrapper/.MainActivity
```

The chip in the top-right reads **Ready** with the printer model once the print
service is bound. Tap it to re-probe.

## Verify the printer service exists

```bash
adb shell pm list packages | grep woyou         # macOS/Linux
adb shell pm list packages | findstr woyou      # Windows
```

If `woyou.aidlservice.jiuiv5` is absent, this device has no Sunmi print service
and the wrapper has nothing to bind — the app says so on launch and falls back
to the Android print dialog.

Watch the binding live:

```bash
adb logcat -s SunmiPrinter
```

---

## Using it

Three tabs, and a Print button that is always reachable.

**Design** is the page. It starts empty; the palette at the bottom appends a
block, and each block is a card you tap to open, edit in place, move with the
arrows, or delete. **Preview** shows the compiled result at true paper width.
**Setup** holds the stock, how a job ends, and the printer check.

| Block | What it puts on paper |
| --- | --- |
| **Text** | Any text, at normal / large / huge size, aligned left, centre or right |
| **Two columns** | Left text and right text on one line, pushed to the paper edges |
| **Line** | A rule across the full paper width, in your choice of character |
| **Space** | 1–10 blank lines |
| **Image** | The bundled default or one picked from the device, at 20–100% width |
| **QR code** | A real QR code, printed by the printer, module size 1–16 |
| **Barcode** | CODE128, any characters, with the caption optionally printed |

The layout is saved to `localStorage` as you edit, so it survives a restart.
**Clear the page** in Setup empties it.

Empty blocks are skipped rather than printed, and a page with nothing on it
refuses to print instead of feeding blank paper.

### Stock

| Stock | Printable | Columns | Height |
| --- | --- | --- | --- |
| 58 mm roll | 48 mm (384 dots) | 32 | continuous |
| 80 mm roll | 72 mm (576 dots) | 48 | continuous |
| 50 × 30 mm sticker | 48 mm (384 dots) | 32 | 30 mm |

Sunmi heads are 203 dpi, which is exactly **8 dots per millimetre**. That is
where the numbers above come from, and it is why a 50 mm sticker gets 48 mm of
ink: the head is 384 dots wide — 48 mm — so roughly 1 mm down each edge of the
sticker is out of reach no matter what. Content is laid out to the printable
width, not the stock width, or it would run off the edge.

### Sticker stock is bounded top and bottom

This is the part that does not apply to a roll. 30 mm is 240 dots, and once you
pass it the print carries on onto the next label. So the Preview tab shows a
height gauge and draws the label edge across the paper; overrun turns both red
and says so.

The height is an **estimate**, not a measurement — the printer does not report
back. Text comes from the line pitch (`LINE_PITCH` in `doc.js`, the one number
to calibrate if labels come out consistently short or long), images from their
dot height, a QR from the version its payload forces, a barcode from its set
height. It is accurate enough for its only job: warning you before you waste a
roll.

Roughly, on a 30 mm label: **8 lines** of normal text, 5 of large, 4 of huge.

### Advancing to the next sticker without a gap sensor

A printer with a gap sensor finds the next label itself. Without one, the only
way is to advance a **fixed distance** every time — which works only if the
distance already consumed is known exactly. An estimate is not enough: a few
dots of error per label compounds until the layout walks off the sticker.

So on sticker stock nothing is printed natively. The whole label is drawn into a
canvas of exactly `384 × 240` dots and sent as **one bitmap**, followed by a
feed of exactly `pitch − 240` dots. Every label then consumes exactly the same
paper — the bitmap is a fixed size no matter what is on it — and registration
becomes arithmetic rather than a guess.

Two consequences worth knowing:

- **The preview is the bitmap.** Not a representation of it — the same pixels,
  at the head's dot pitch. What overflows the sticker is clipped there exactly
  as it will be clipped on paper.
- **Text is rendered here, not by the printer.** Its font metrics stop mattering,
  which is what makes the height exact.

The feed uses `ESC J n`, which advances 1/203 inch — one dot — per unit, split
across several commands past 255. `lineWrap()` cannot do this: it moves in whole
text lines, and a line is not a divisor of the gap between two stickers.

**Label pitch** is the one number to get right: top of one sticker to the top of
the next, so the label plus the die-cut gap (33 mm for 30 mm labels with a 3 mm
gap). Measure it on your roll, then fine-tune with **Print calibration strip**,
which prints three stickers with a bar on the top and bottom edge of each:

- bars on the edges of all three → the pitch is right;
- bars creeping **up** each label → the pitch is short;
- bars creeping **down** → the pitch is long.

Nudge by ±1 dot (0.125 mm) and reprint. The drift per label is the error, so a
bar that moves 1 mm over three labels means the pitch is out by about 0.33 mm.

**Copies per print** repeats the label in one go, each with its own feed.

> **Untested against hardware.** The arithmetic is verified — constant bitmap
> height, exact `ESC J` byte sequences, correct chunking — but whether your unit
> honours `ESC J` at all, and how much the mechanism slips over a long run,
> could not be checked here without a device. Start with the calibration strip
> before committing a roll. If `ESC J` does nothing, the feed falls back to
> whole lines, which will not register exactly.

Paper cutting is suppressed on sticker stock, since a label is peeled off its
liner rather than cut.

### Images

The default is `img/logo-default.png` — a copy of the React app's
`src/assets/images-dynamic.png`. **From device** opens the system picker; the
chosen image is downscaled to 800px before it is kept, because localStorage
would otherwise fill up with a camera-sized photo. You can add as many image
blocks as you like, each with its own source and width.

Whatever the source, the image is flattened onto white, trimmed of its blank
margin, scaled to the requested share of the print head's dot width (384 dots at
58mm, 576 at 80mm), and Floyd-Steinberg dithered to 1-bit — a receipt printer
has no greys, so a plain threshold would silently erase the light tones. The
preview shows the actual dot pattern, not a smoothed lie.

That work happens in the page rather than in Kotlin because the target width is
decided by the paper-size setting, which lives there. The bitmap crosses the
binder as a Parcelable, so it has to stay under the ~1MB transaction limit;
scaling to head width keeps it far below.

---

## Layout

| File | Role |
| --- | --- |
| `aidl/woyou/aidlservice/jiuiv5/IWoyouService.aidl` | Sunmi's printer interface, copied verbatim |
| `aidl/woyou/aidlservice/jiuiv5/ICallback.aidl` | Result callback interface |
| `SunmiPrinterService.kt` | Binds the service, wraps the calls |
| `PrinterBridge.kt` | The `@JavascriptInterface` object exposed to the page |
| `MainActivity.kt` | WebView host, asset serving, image picker |
| `assets/index.html` | The composer UI |
| `assets/js/doc.js` | The document — blocks, and compiling them to the paper |
| `assets/js/logo.js` | Image → 1-bit dithered bitmap |
| `assets/js/label.js` | Sticker mode: the whole label drawn to one exact bitmap |
| `assets/js/qr.js` | QR encoding, byte mode |
| `assets/js/code128.js` | CODE128 encoding, subsets B and C |
| `assets/js/bridge.js` | Bridge detection, printing, rendering |
| `assets/js/app.js` | The block editor |

`qr.js` and `code128.js` exist because label mode composites the whole sticker
itself — a symbol drawn by the printer cannot be part of a bitmap whose height
has to be known in advance. On roll stock the printer still draws both natively.

`qr.js` is verified module-for-module against Project Nayuki's qrcodegen across
624 symbols spanning every version and error-correction level. `code128.js` is
checked against the pattern table's structural invariants — 11 modules and even
bar parity per symbol — and by decoding its own output back to the input.

### Authored blocks and compiled blocks

`doc.js` holds two shapes, and the distinction matters. **Authored** blocks are
what the editor edits (`{type: "text", text, align, size}`). `compile()` turns
them into **compiled** blocks: text wrapped to the column count, images resolved
to dithered bitmaps, dividers expanded to a full-width run of characters, empty
blocks dropped.

The preview, the printer and the browser fallback all walk that same compiled
list, which is why the preview matches the paper.

Text is wrapped to the column count *before* it reaches the printer, and a
larger font gets a proportionally smaller wrap width, because the printer would
otherwise break the lines itself at a place you did not choose.

### Alignment and font size are printer modes

Neither is an argument to a print call — they are set, then they stay set. Every
block that changes either one puts it back afterwards, or the next block
silently inherits it. That is what `withAlign()` in `bridge.js` is for.

### Why the UI is served over https, not file://

`MainActivity` serves the assets through `WebViewAssetLoader` at
`https://appassets.androidplatform.net/assets/`. Nothing goes to the network —
requests to that host are answered from the APK. The point is the origin: a
`file://` page has an opaque one, which makes `getImageData()` throw on any
canvas an image has been drawn into, and disables `localStorage`. Both are
load-bearing here.

### Do not edit the AIDL files

AIDL assigns binder transaction codes **by declaration order**. Reordering,
inserting, or deleting a method shifts every code after it, and calls then land
on the wrong method on the device — usually with no error, just wrong output.

`IWoyouService.aidl` is deliberately truncated after `printOriginalText()`. The
methods below it in the full interface (`commitPrint`, `tax`, …) pull in the
`TransBean` and `ITax` types, which we would otherwise have to vendor for no
reason. Everything kept above it retains its original transaction code, so the
trimmed interface stays wire-compatible with the service on the device.

## Adding a block type

Add it to `BLOCK_TYPES` and `createBlock()` in `doc.js`, give it a case in
`compile()`, an editor in `buildEditor()` in `app.js`, and — if it needs a
printer call the bridge does not make yet — a case in `printViaBridge()` plus a
matching `@JavascriptInterface` method in `PrinterBridge.kt` and its wrapper in
`SunmiPrinterService.kt`. Only primitives and Strings cross the WebView bridge;
byte arrays must be base64-encoded, which is what `sendRAWData` already does.
