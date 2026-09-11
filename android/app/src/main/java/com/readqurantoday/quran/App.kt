package com.readqurantoday.quran

import android.app.Application

/**
 * The app, before any of it is on screen.
 *
 * The theme and the language are chosen here and nowhere else. Both are set
 * through statics on AppCompat, and a static is a thing the process owns: it
 * survives every screen and dies with the process. Set from inside an activity
 * — which is where this was — the first screen of a cold start is already built
 * before the choice is made, and it is built to the phone's taste rather than
 * the reader's. It gets corrected a moment later, so the second launch looks
 * right and only the first is wrong. That is the whole of the bug that showed a
 * light page in a dark hand on a fresh install and not afterwards.
 *
 * Said here, it is true before there is anything to be wrong.
 */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Settings.applyTheme(this)
        Settings.applyLanguage(this)

        /* Which ayah every word belongs to, counted once over all 604 pages. It
           is wanted only when somebody asks to be read to, and it takes long
           enough that doing it then would be felt — so it is done now, on a
           thread nothing is waiting for. */
        Thread {
            Mushaf.load(this)
            Ayat.build(this)
        }.apply { priority = Thread.MIN_PRIORITY }.start()
    }
}
