package com.readqurantoday.quran

import android.content.Context

/**
 * Which ayah each word belongs to, and which word of it it is.
 *
 * The page data does not say. It gives a page's words as glyphs, and separately
 * the glyphs that close an ayah — so the numbering is recovered by reading the
 * mushaf the way it is read: from where a surah begins, count a marker as the
 * end of one ayah and the start of the next.
 *
 * That means a word's number depends on every word before it, back to the start
 * of its surah, which is no good for a reader that opens on page 300. So one
 * pass is made over all 604 pages and the state each page opens in is written
 * down. After that any page can be numbered on its own, from its own opening
 * state, without reading anything before it.
 *
 * The web reader does exactly this and checks out: counted this way, the ayah
 * totals agree with surahs.json for all 114 surahs, which they would not if a
 * marker were ever missed or counted twice.
 */
object Ayat {

    /* The surah, ayah and word count as each page opens. */
    private val atSurah = IntArray(606)
    private val atAyah = IntArray(606)
    private val atWord = IntArray(606)

    /** The page an ayah's first word is printed on, by "surah:ayah". */
    private val opensOn = HashMap<Int, Int>(6300)

    @Volatile
    var ready = false
        private set

    private fun key(surah: Int, ayah: Int) = surah * 1000 + ayah

    /**
     * Read the whole mushaf once and note where each page stands.
     *
     * About 78,000 words. Done off the main thread, at startup, so that it is
     * long finished before anybody asks to be read to.
     */
    fun build(context: Context) {
        if (ready) return
        val ctx = context.applicationContext

        var s = 0
        var v = 0
        var w = 0

        for (p in 1..604) {
            atSurah[p] = s
            atAyah[p] = v
            atWord[p] = w

            val marks = Mushaf.marksOn(p)
            for (line in Mushaf.lines(p)) {
                if (line.kind == "surah") {
                    s = line.surah
                    v = 1
                    w = 0
                }
                if (line.kind != "ayah") continue

                for (parts in line.words) {
                    val word = parts.joinToString(" ")
                    if (marks.contains(word)) {
                        v++
                        w = 0
                    } else {
                        /* An ayah belongs to the page its first word is printed
                           on, which is the page to turn to when it is recited —
                           not the page its number happens to fall on. */
                        if (w == 0) opensOn.getOrPut(key(s, v)) { p }
                        w++
                    }
                }
            }
        }
        /* Nothing above touches a face, but the lines of all 604 pages are now
           parsed and held; the reader only wants the ones near it. */
        Mushaf.keepOnly(1..2)
        ctx.let { }
        ready = true
    }

    fun surahAt(page: Int) = atSurah.getOrElse(page) { 0 }
    fun ayahAt(page: Int) = atAyah.getOrElse(page) { 0 }
    fun wordAt(page: Int) = atWord.getOrElse(page) { 0 }

    /** Which page to turn to for this ayah, or 0 if it is not known yet. */
    fun pageOf(surah: Int, ayah: Int) = opensOn[key(surah, ayah)] ?: 0
}
