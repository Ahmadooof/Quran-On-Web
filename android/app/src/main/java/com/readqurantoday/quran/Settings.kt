package com.readqurantoday.quran

import android.content.Context
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat

/**
 * What the reader remembers about how it should look, and where it has been.
 *
 * One store, shared by the reader and the index, because the index offers the
 * page the reader was last on and the saved pages it was asked to keep.
 *
 * The web's settings pane has a dozen rows; most of them answer questions a
 * phone does not ask. Text size and reading mode belong to a window that can be
 * any shape — here a page is fitted to the screen's width and there is one of
 * it. Offline reading is what this app is: the whole mushaf is in the package.
 * Page arrows and keyboard gestures are a desktop's. What is left is what a
 * phone actually changes while reading: how dark the screen is, and which pages
 * to come back to. Screen brightness was here too and should not have been —
 * the phone already has that control, and a second one that disagrees with it
 * is worse than none.
 */
object Settings {

    private const val PREFS = "reader"
    private const val THEME = "theme"
    private const val MARKS = "bookmarks"
    private const val LAST_PAGE = "last-page"
    private const val RECITER = "reciter"
    private const val LANG = "language"

    /** Follow the phone, or override it. */
    const val BY_SYSTEM = 0
    const val LIGHT = 1
    const val DARK = 2

    private fun store(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /* ---------- theme ------------------------------------------------------ */

    fun theme(context: Context) = store(context).getInt(THEME, BY_SYSTEM)

    fun setTheme(context: Context, mode: Int) {
        store(context).edit().putInt(THEME, mode).apply()
        apply(mode)
    }

    /** Put the remembered theme on, before anything is drawn in it. */
    fun applyTheme(context: Context) = apply(theme(context))

    private fun apply(mode: Int) {
        AppCompatDelegate.setDefaultNightMode(
            when (mode) {
                LIGHT -> AppCompatDelegate.MODE_NIGHT_NO
                DARK -> AppCompatDelegate.MODE_NIGHT_YES
                else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            }
        )
    }

    /* ---------- saved pages -------------------------------------------------- */

    /** The pages kept, in reading order. */
    fun marks(context: Context): List<Int> =
        store(context).getStringSet(MARKS, emptySet())
            .orEmpty()
            .mapNotNull { it.toIntOrNull() }
            .sorted()

    fun marked(context: Context, page: Int) = marks(context).contains(page)

    /** Keep this page, or stop keeping it. Answers with what it now is. */
    fun toggleMark(context: Context, page: Int): Boolean {
        val kept = marks(context).toMutableSet()
        val on = kept.add(page)
        if (!on) kept.remove(page)
        store(context).edit().putStringSet(MARKS, kept.map { it.toString() }.toSet()).apply()
        return on
    }

    /* ---------- the language -------------------------------------------------- */

    /**
     * Which language the app speaks: "ar" or "en".
     *
     * The mushaf is not in it either way. The page is drawn from the Madinah
     * faces whatever this says; what turns is the chrome around it — the tabs,
     * the settings, the words on the running head — which is what the website's
     * own switch turns and no more.
     */
    fun language(context: Context): String = store(context).getString(LANG, "ar") ?: "ar"

    fun setLanguage(context: Context, tag: String) {
        store(context).edit().putString(LANG, tag).apply()
        speak(tag)
    }

    fun applyLanguage(context: Context) = speak(language(context))

    private fun speak(tag: String) {
        AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(tag))
    }

    /* ---------- the voice ---------------------------------------------------- */

    /** Which recitation was chosen, or null for whichever is offered first. */
    fun reciter(context: Context): String? = store(context).getString(RECITER, null)

    fun setReciter(context: Context, id: String) {
        store(context).edit().putString(RECITER, id).apply()
    }

    /* ---------- where the reader was ----------------------------------------- */

    fun lastPage(context: Context) = store(context).getInt(LAST_PAGE, 0)

    fun setLastPage(context: Context, page: Int) {
        store(context).edit().putInt(LAST_PAGE, page).apply()
    }
}
