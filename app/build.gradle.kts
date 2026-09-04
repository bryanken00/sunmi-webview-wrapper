plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The app is standalone: the receipt builder ships inside the APK, under
// app/src/main/assets, and that is what the WebView loads when this is empty.
//
// Set it to point the WebView at a server instead — the React app in this repo,
// or a Vite dev server on the LAN:
//   ./gradlew assembleDebug -PappUrl=http://192.168.1.20:5173
val appUrl: String = (project.findProperty("appUrl") as String?) ?: ""

android {
    namespace = "com.dgs.sunmiwrapper"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.dgs.sunmiwrapper"
        // Sunmi V2 ships Android 7.1; keep the floor low enough to install.
        minSdk = 24
        targetSdk = 34
        versionCode = 2
        versionName = "2.0"

        buildConfigField("String", "APP_URL", "\"$appUrl\"")
    }

    buildFeatures {
        aidl = true
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Debug-signed release so `assembleRelease` produces something
            // installable without setting up a keystore first.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.activity:activity-ktx:1.8.2")
    // WebViewAssetLoader — serves the bundled UI over https instead of file://.
    // A file:// page has an opaque origin, which taints the canvas the logo
    // dithering has to read back with getImageData(), and disables localStorage.
    implementation("androidx.webkit:webkit:1.8.0")
}
