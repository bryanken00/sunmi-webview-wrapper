package com.dgs.sunmiwrapper

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.Bitmap
import android.os.IBinder
import android.os.RemoteException
import android.util.Log
import woyou.aidlservice.jiuiv5.ICallback
import woyou.aidlservice.jiuiv5.IWoyouService

/**
 * Binds the Sunmi built-in printer service and exposes the few operations the
 * web layer needs.
 *
 * The printer is NOT a USB device — it is reached only through this AIDL
 * service (or the virtual `InnerPrinter` Bluetooth device). Binding is async,
 * so calls made before [isReady] are dropped rather than queued; the WebView
 * checks readiness through the JS bridge before printing.
 */
class SunmiPrinterService(private val context: Context) {

    companion object {
        private const val TAG = "SunmiPrinter"
        private const val SERVICE_PACKAGE = "woyou.aidlservice.jiuiv5"
        private const val SERVICE_ACTION = "woyou.aidlservice.jiuiv5.IWoyouService"
    }

    private var service: IWoyouService? = null

    val isReady: Boolean
        get() = service != null

    /** Fired when the binding succeeds or is lost, so the UI can react. */
    var onConnectionChanged: ((Boolean) -> Unit)? = null

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            service = IWoyouService.Stub.asInterface(binder)
            Log.i(TAG, "Connected to $SERVICE_PACKAGE")
            onConnectionChanged?.invoke(true)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            // The service process died; Android will call onServiceConnected
            // again when it comes back, so keep the connection registered.
            service = null
            Log.w(TAG, "Disconnected from $SERVICE_PACKAGE")
            onConnectionChanged?.invoke(false)
        }
    }

    /** No-op callback — we do not surface per-call results to JS yet. */
    private val noopCallback = object : ICallback.Stub() {
        override fun onRunResult(isSuccess: Boolean) = Unit
        override fun onReturnString(result: String?) = Unit
        override fun onRaiseException(code: Int, msg: String?) {
            Log.e(TAG, "Printer exception $code: $msg")
        }

        override fun onPrintResult(code: Int, msg: String?) {
            if (code != 0) Log.e(TAG, "Print failed $code: $msg")
        }
    }

    /**
     * @return false if the print service is not installed on this device, in
     *   which case there is nothing to bind and the caller should say so.
     */
    fun connect(): Boolean {
        val intent = Intent().apply {
            setPackage(SERVICE_PACKAGE)
            action = SERVICE_ACTION
        }
        return try {
            context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
        } catch (error: SecurityException) {
            Log.e(TAG, "Not allowed to bind the print service", error)
            false
        }
    }

    fun disconnect() {
        if (service == null) return
        runCatching { context.unbindService(connection) }
        service = null
    }

    /**
     * Run a printer call, swallowing the RemoteException that occurs when the
     * service dies mid-call.
     * @return whether the call reached the service
     */
    private fun withService(block: (IWoyouService) -> Unit): Boolean {
        val target = service ?: return false
        return try {
            block(target)
            true
        } catch (error: RemoteException) {
            Log.e(TAG, "Printer call failed", error)
            false
        }
    }

    fun init(): Boolean = withService { it.printerInit(noopCallback) }

    fun printText(text: String): Boolean = withService { it.printText(text, noopCallback) }

    fun sendRaw(data: ByteArray): Boolean = withService { it.sendRAWData(data, noopCallback) }

    fun lineWrap(lines: Int): Boolean = withService { it.lineWrap(lines, noopCallback) }

    /**
     * The bitmap crosses the binder as a Parcelable, so it must stay within the
     * ~1MB transaction limit — the web side already scales it to the head's dot
     * width, which keeps it far below that.
     */
    fun printBitmap(bitmap: Bitmap): Boolean =
        withService { it.printBitmap(bitmap, noopCallback) }

    fun setAlignment(alignment: Int): Boolean =
        withService { it.setAlignment(alignment, noopCallback) }

    /**
     * Changes character width as well as height, so anything laid out in fixed
     * columns has to be printed at the default size — the web side only raises
     * it for blocks the printer centres itself.
     */
    fun setFontSize(size: Float): Boolean =
        withService { it.setFontSize(size, noopCallback) }

    /**
     * @param moduleSize dot size of one QR module, 1..16
     * @param errorLevel 0=L(7%) 1=M(15%) 2=Q(25%) 3=H(30%)
     */
    fun printQRCode(data: String, moduleSize: Int, errorLevel: Int): Boolean =
        withService { it.printQRCode(data, moduleSize, errorLevel, noopCallback) }

    /**
     * @param symbology 8 = CODE128, which is the only one that takes arbitrary
     *   text; the numeric-only types reject a receipt number with a letter in it
     * @param height 1..255 dots
     * @param width module width, 2..6
     * @param textPosition 0=none 1=above 2=below 3=both
     */
    fun printBarCode(
        data: String,
        symbology: Int,
        height: Int,
        width: Int,
        textPosition: Int
    ): Boolean = withService {
        it.printBarCode(data, symbology, height, width, textPosition, noopCallback)
    }

    /** @return "model / serial", or null if the service is not bound. */
    fun describe(): String? {
        val target = service ?: return null
        return try {
            "${target.printerModal ?: "unknown"} / ${target.printerSerialNo ?: "unknown"}"
        } catch (error: RemoteException) {
            Log.e(TAG, "Could not read printer identity", error)
            null
        }
    }
}
