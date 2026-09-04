package com.dgs.sunmiwrapper

import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface

/**
 * The object injected into the page as `window.AndroidPrinter`.
 *
 * Method names here are deliberately the ones the web app already probes for
 * in `src/utils/thermalPrinter.js` — `printerInit`, `printText`, `sendRAWData`,
 * `lineWrap`. Renaming any of them breaks detection on the web side.
 *
 * Every method runs on the WebView's JavaBridge thread, never the UI thread,
 * so the binder calls below are safe to make directly. Only primitives and
 * Strings cross this boundary — anything else is silently dropped by the
 * WebView bridge.
 */
class PrinterBridge(private val printer: SunmiPrinterService) {

    /** @return whether the print service is bound and ready to take work. */
    @JavascriptInterface
    fun isReady(): Boolean = printer.isReady

    /** @return "model / serial", or an empty string when not bound. */
    @JavascriptInterface
    fun getStatus(): String = printer.describe() ?: ""

    @JavascriptInterface
    fun printerInit(): Boolean = printer.init()

    @JavascriptInterface
    fun printText(text: String?): Boolean {
        if (text.isNullOrEmpty()) return false
        return printer.printText(text)
    }

    /**
     * @param base64 ESC/POS payload, base64-encoded — the web side cannot hand
     *   a byte array across the bridge, so it encodes first.
     */
    @JavascriptInterface
    fun sendRAWData(base64: String?): Boolean {
        if (base64.isNullOrEmpty()) return false
        val bytes = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
            return false
        }
        return printer.sendRaw(bytes)
    }

    @JavascriptInterface
    fun lineWrap(lines: Int): Boolean = printer.lineWrap(lines)

    /**
     * Print a logo.
     *
     * @param base64 a PNG, base64-encoded, already dithered to 1-bit and scaled
     *   to the print head's dot width by the web side — doing that in the
     *   browser keeps the sizing logic next to the paper-width setting that
     *   determines it.
     */
    @JavascriptInterface
    fun printBitmapBase64(base64: String?): Boolean {
        if (base64.isNullOrEmpty()) return false

        val bytes = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
            Log.e("SunmiPrinter", "Logo was not valid base64", error)
            return false
        }

        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        if (bitmap == null) {
            Log.e("SunmiPrinter", "Logo bytes did not decode to an image")
            return false
        }

        return try {
            printer.printBitmap(bitmap)
        } finally {
            bitmap.recycle()
        }
    }

    /** 0 = left, 1 = center, 2 = right. */
    @JavascriptInterface
    fun setAlignment(alignment: Int): Boolean = printer.setAlignment(alignment)

    /**
     * Sunmi's default is 24. Changing it also changes character width, so the
     * page only uses it on blocks the printer centres itself — a column layout
     * padded with spaces would come out crooked.
     */
    @JavascriptInterface
    fun setFontSize(size: Int): Boolean = printer.setFontSize(size.toFloat())

    /**
     * Print a QR code natively, rather than as an image.
     *
     * @param moduleSize dot size of one module, 1..16
     * @param errorLevel 0=L 1=M 2=Q 3=H
     */
    @JavascriptInterface
    fun printQRCode(data: String?, moduleSize: Int, errorLevel: Int): Boolean {
        if (data.isNullOrEmpty()) return false
        return printer.printQRCode(
            data,
            moduleSize.coerceIn(1, 16),
            errorLevel.coerceIn(0, 3)
        )
    }

    /**
     * @param symbology 8 = CODE128; see IWoyouService.aidl for the rest
     * @param textPosition 0=none 1=above 2=below 3=both
     */
    @JavascriptInterface
    fun printBarCode(
        data: String?,
        symbology: Int,
        height: Int,
        width: Int,
        textPosition: Int
    ): Boolean {
        if (data.isNullOrEmpty()) return false
        return printer.printBarCode(
            data,
            symbology,
            height.coerceIn(1, 255),
            width.coerceIn(2, 6),
            textPosition.coerceIn(0, 3)
        )
    }
}
