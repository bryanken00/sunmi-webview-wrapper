package com.dgs.sunmiwrapper

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader

/**
 * Full-screen WebView that hosts the receipt builder and hands it the printer.
 *
 * The app is standalone: the whole UI lives in `app/src/main/assets` and is
 * served from there, so the device needs no network and no server. Building
 * with `-PappUrl=...` points the WebView at a remote page instead, which is how
 * the React app in this repo is driven during development.
 */
class MainActivity : AppCompatActivity() {

    private companion object {
        /**
         * WebViewAssetLoader's reserved host. Nothing is fetched over the
         * network — requests to it are intercepted below and answered from the
         * APK's assets — but using https gives the page a real origin, which
         * file:// does not. That matters: the logo dithering calls
         * getImageData() on a canvas, which throws on an opaque origin, and
         * localStorage is disabled there too.
         */
        const val BUNDLED_APP_URL = "https://appassets.androidplatform.net/assets/index.html"
    }

    private lateinit var webView: WebView
    private lateinit var printer: SunmiPrinterService
    private lateinit var imageChooser: ActivityResultLauncher<Intent>

    /** Set while the system picker is up, so its result can be handed back to the page. */
    private var pendingFiles: ValueCallback<Array<Uri>>? = null

    private val assetLoader: WebViewAssetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Must be registered before the activity is STARTED, so it cannot move
        // into the WebChromeClient below.
        imageChooser = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            val callback = pendingFiles ?: return@registerForActivityResult
            pendingFiles = null
            callback.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            )
        }

        printer = SunmiPrinterService(this)
        if (!printer.connect()) {
            // Nothing to bind to — almost always means this is not a Sunmi
            // device, or the print service was removed from the ROM. The UI
            // still works; it just falls back to the print dialog.
            Toast.makeText(this, R.string.printer_service_missing, Toast.LENGTH_LONG).show()
        }

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // The bundled UI is reached over the asset loader's https host, not
            // file://, so no file system access is needed — leaving it off keeps
            // the surface small.
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.setSupportZoom(false)

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
            }

            webChromeClient = object : WebChromeClient() {
                /** Makes `<input type="file">` in the page open the system picker. */
                override fun onShowFileChooser(
                    view: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?
                ): Boolean {
                    // Only one picker can be outstanding; release an abandoned
                    // one or the page's input would wait forever.
                    pendingFiles?.onReceiveValue(null)
                    pendingFiles = filePathCallback

                    val intent = fileChooserParams?.createIntent()
                    if (intent == null) {
                        pendingFiles = null
                        return false
                    }

                    return try {
                        imageChooser.launch(intent)
                        true
                    } catch (error: ActivityNotFoundException) {
                        pendingFiles = null
                        Toast.makeText(
                            this@MainActivity,
                            R.string.no_image_picker,
                            Toast.LENGTH_LONG
                        ).show()
                        false
                    }
                }
            }

            addJavascriptInterface(PrinterBridge(printer), "AndroidPrinter")
            loadUrl(BuildConfig.APP_URL.ifEmpty { BUNDLED_APP_URL })
        }
        setContentView(webView)

        // Back navigates the page, and only exits once history is empty.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }

    override fun onDestroy() {
        pendingFiles?.onReceiveValue(null)
        pendingFiles = null
        printer.disconnect()
        webView.destroy()
        super.onDestroy()
    }
}
