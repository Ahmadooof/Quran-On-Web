plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}


/**
 * Put the reader in the package, as part of building.
 *
 * This used to be `npm run sync:android`, remembered by hand, which meant the
 * app showed whatever the last person to remember had copied. Gradle knows
 * when public/ has changed and when it has not, so the copy happens exactly
 * when it is needed and is skipped — UP-TO-DATE — when it is not.
 *
 * The recitations and the 114 pre-rendered surah pages are left out of what is
 * watched as well as out of what is copied: the recitations alone are 5.7 GB,
 * and hashing them to decide whether to copy files that are never copied would
 * cost more than the build.
 */
val syncWebAssets = tasks.register<Exec>("syncWebAssets") {
    val repo = rootProject.file("..")
    val script = File(repo, "scripts/sync-android-assets.js")
    val source = File(repo, "public")

    group = "build"
    description = "Copies the reader from public/ into the app's assets."

    inputs.files(
        fileTree(source) {
            exclude("audio/**", "surah/**")
        }
    ).withPropertyName("reader").withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file(script).withPathSensitivity(PathSensitivity.RELATIVE)
    outputs.dir(file("src/main/assets"))

    workingDir = repo

    /* node is a .cmd shim on Windows, which only the shell can start. */
    commandLine =
        if (System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) {
            listOf("cmd", "/c", "node", script.absolutePath)
        } else {
            listOf("node", script.absolutePath)
        }
}

android {
    namespace = "com.readqurantoday.quran"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.readqurantoday.quran"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
    }

    /* Two asset folders, kept apart on purpose.
     *
     * src/main/assets is the web reader and is wiped and rewritten by the sync
     * script on every build; anything else put there would be deleted. The
     * decoded page fonts belong to the native reader, are written by a
     * different script, and so live in their own folder — packaged the same
     * way, at the root of assets, but never in the sync script's way. */
    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets", "src/main/fonts-ttf")
        }
    }

    /* Both font formats are already compressed, or in the TTF's case are read
       by mapping the file — packing them again costs build time and saves
       nothing, and a compressed asset cannot be memory-mapped at all. */
    androidResources {
        noCompress += listOf("woff2", "ttf")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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

/* Every build, not only a release: an app built from stale assets is the thing
   this is here to prevent, and Gradle skips the work when nothing has moved. */
tasks.named("preBuild") {
    dependsOn(syncWebAssets)
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    /* The pages, and the index. It arrived on ViewPager2's coat-tails until
       the reader stopped using one, so it is asked for by name now. */
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    /* The native reader's paging: the platform's own, so the gesture is the
       platform's too. */
    /* WindowInsetsControllerCompat, for the system bars. It arrives with
       appcompat anyway; named here because this module uses it directly. */
    implementation("androidx.core:core-ktx:1.13.1")
    /* The audio player. Android's MediaPlayer.seekTo() fails silently on VBR
       (variable-bit-rate) MP3 streams because it cannot calculate byte offsets
       without a fixed bitrate. ExoPlayer parses MPEG frames to find accurate
       positions in VBR files, the same way a browser's audio.currentTime works.
       It also accepts seekTo() before prepare(), so the async race that required
       pendingPlay / pendingStart flags is gone: the player simply arrives at the
       asked-for word the moment it is ready. */
    implementation("androidx.media3:media3-exoplayer:1.4.1")
}
