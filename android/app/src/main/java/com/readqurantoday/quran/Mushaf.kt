package com.readqurantoday.quran

import android.content.Context
import android.graphics.Typeface
import android.os.Build
import org.json.JSONObject

/**
 * The mushaf, as the reader needs it: 604 pages of lines, and a face per page.
 *
 * Every page of this edition is set in a font of its own, and the glyphs in it
 * are private-use codepoints — one per word, usually, sometimes two. The font
 * holds the shape of every word on that page and nothing else, which is why
 * there are 604 of them and why a page cannot be drawn with the wrong one: the
 * same codepoint means a different word on a different page.
 *
 * That arrangement does the hard part for us. A word is a codepoint, the font
 * turns it into the right shape, and drawing a page is placing runs along a
 * line — no shaping, no bidi, no diacritic stacking to get right, because the
 * face was cut with all of it already resolved.
 */
object Mushaf {

    /**
     * A line of a page: words in reading order, and what kind of line it is.
     *
     * A word is itself a list, because a few of them are written with a space
     * inside — two glyphs that belong to one word but are set apart on the
     * page. That space is a problem worth taking seriously: the page's own face
     * has no space glyph in it, so a run containing one is resolved through
     * whatever font the system falls back to, and the fallback chosen while
     * measuring is not always the one chosen while drawing. Words landed on top
     * of one another wherever that happened.
     *
     * Split here instead. Every run that reaches the canvas is then made only
     * of glyphs the page's face actually has, and the space between the parts
     * is one this reader decides rather than one it inherits.
     */
    data class Line(val kind: String, val words: List<List<String>>, val surah: Int = 0)

    /**
     * A page's codepoints said as glyphs: which glyph a codepoint is, and how
     * wide it is in the font's own units.
     *
     * This is read out of the face beforehand, by scripts/glyph-maps.js, and it
     * exists so that drawing a page asks the system nothing. Handed a string,
     * the system reads a script in these codepoints — they are U+FC41 upward,
     * Arabic presentation forms — and brings the whole Arabic apparatus to bear
     * on glyphs that were cut with all of that already resolved. Handed glyph
     * numbers, it draws the glyphs.
     */
    class Glyphs(val upem: Float, private val gid: HashMap<Int, Int>, private val adv: HashMap<Int, Int>) {
        /** The glyph this codepoint is, or -1 if the face has not got it. */
        fun id(cp: Int): Int = gid[cp] ?: -1

        /** Its advance, in font units. */
        fun advance(cp: Int): Float = (adv[cp] ?: 0).toFloat()
    }

    /** How wide a full line is in ems of its own type size, from mushaf.json. */
    var emWidth = 15.98
        private set

    /** A line narrower than this fraction of the measure is centred, not fitted. */
    var centreBelow = 0.92
        private set

    /** The four words, and the page whose face draws them. */
    var basmalah: List<String> = emptyList()
        private set
    var basmalahPage = 1
        private set

    private var pages: JSONObject? = null
    private var marks: JSONObject? = null
    private val faces = HashMap<Int, Typeface>()
    private val tables = HashMap<Int, Glyphs>()
    private var nameTable: Glyphs? = null
    private var nameFont: android.graphics.fonts.Font? = null
    private var nameFamily: Typeface? = null
    private val fonts = HashMap<Int, android.graphics.fonts.Font>()

    /* A page's lines, once read out of the file. Reading them is cheap and
       doing it while a page is being turned is not: it lands on the frame that
       binds the incoming page, which is the one frame of a turn that has any
       work in it at all. */
    private val parsed = HashMap<Int, List<Line>>()

    private val ahead = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
        Thread(r, "mushaf-ahead").apply { priority = Thread.MIN_PRIORITY }
    }

    /* Loading the whole file costs about a megabyte and happens once. Reading a
       page out of it is then a lookup rather than a parse. */
    fun load(context: Context) {
        if (pages != null) return

        val json = context.assets.open("data/mushaf.json").use { it.readBytes() }
        val root = JSONObject(String(json, Charsets.UTF_8))

        pages = root.getJSONObject("pages")
        marks = root.optJSONObject("marks")

        /* The Basmalah is written once, apart from the pages, because it is the
           same four words wherever it is printed — and it is drawn in the face
           of the page it is quoted from, not of the page it appears on. */
        root.optJSONObject("basmalah")?.let { b ->
            basmalahPage = b.optInt("page", 1)
            val text = b.optString("v2", "")
            basmalah = if (text.isEmpty()) emptyList() else text.split('|').filter { it.isNotEmpty() }
        }

        root.optJSONObject("fit")?.let { fit ->
            fit.optJSONObject("body")?.let { emWidth = it.optDouble("v2", emWidth) }
            fit.optJSONObject("centreBelow")?.let { centreBelow = it.optDouble("v2", centreBelow) }
        }
    }

    @Synchronized
    fun lines(page: Int): List<Line> {
        parsed[page]?.let { return it }

        val all = pages ?: return emptyList()
        val arr = all.optJSONArray(page.toString()) ?: return emptyList()

        val out = ArrayList<Line>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val kind = o.optString("t")
            /* v2 is this edition; the file carries v1 beside it for the older
               one, which the reader does not offer. */
            val text = o.optString("v2", "")
            out.add(
                Line(
                    kind = kind,
                    words = if (text.isEmpty()) emptyList()
                            else text.split('|').map { w -> w.split(' ').filter { it.isNotEmpty() } },
                    surah = o.optInt("s", 0)
                )
            )
        }
        parsed[page] = out
        return out
    }

    /**
     * Read the pages around this one, on a thread of no importance.
     *
     * Everything a page needs the first time it is drawn — its lines out of the
     * file, its face mapped from the package — costs a few milliseconds, and a
     * few milliseconds spent while a page is turning is a dropped frame. Spent
     * a moment earlier, on a thread that nothing is waiting for, it is free.
     */
    fun warm(context: Context, page: Int) {
        val ctx = context.applicationContext
        ahead.execute {
            for (p in (page - 2)..(page + 2)) {
                if (p in 1..604) {
                    lines(p)
                    face(ctx, p)
                    glyphs(ctx, p)
                    font(ctx, p)
                }
            }
        }
    }

    /**
     * The face this page is set in.
     *
     * Kept once loaded: a Typeface is a handle to a memory-mapped file, so
     * holding all 604 would be 152 MB of address space for pages nobody is
     * reading. The reader asks for the pages around it and lets the rest go.
     */
    @Synchronized
    fun face(context: Context, page: Int): Typeface? {
        faces[page]?.let { return it }
        return try {
            val t = Typeface.createFromAsset(context.assets, "p$page.ttf")
            faces[page] = t
            t
        } catch (e: RuntimeException) {
            null
        }
    }

    /**
     * This page's glyph table.
     *
     * A few kilobytes of text per page — a line of "codepoint glyph advance"
     * apiece, and the units per em on the first line.
     */
    @Synchronized
    fun glyphs(context: Context, page: Int): Glyphs? {
        tables[page]?.let { return it }
        val g = read(context, "g$page.txt") ?: return null
        tables[page] = g
        return g
    }

    /**
     * The glyphs that close an ayah on this page, as one string to look in.
     *
     * The page data names no ayah numbers; it gives the words, and separately
     * the marks that end a verse. That is all the reader needs to set them
     * apart from the words they follow — which the mushaf does, and the web
     * reader does in the same blue it labels the page with.
     */
    fun marksOn(page: Int): String = marks?.optString(page.toString(), "").orEmpty()

    /** One glyph table, out of one file. */
    private fun read(context: Context, asset: String): Glyphs? {
        return try {
            val text = context.assets.open(asset).use { it.readBytes() }
            val rows = String(text, Charsets.US_ASCII).lineSequence()
            var upem = 0f
            val gid = HashMap<Int, Int>(512)
            val adv = HashMap<Int, Int>(512)
            for (row in rows) {
                if (row.isEmpty()) continue
                if (upem == 0f) { upem = row.trim().toFloat(); continue }
                val a = row.indexOf(' ')
                val b = row.indexOf(' ', a + 1)
                if (a < 0 || b < 0) continue
                val cp = row.substring(0, a).toInt()
                gid[cp] = row.substring(a + 1, b).toInt()
                adv[cp] = row.substring(b + 1).trim().toInt()
            }
            Glyphs(upem, gid, adv)
        } catch (e: Exception) {
            null
        }
    }

    /**
     * The face again, as a Font rather than a Typeface.
     *
     * drawGlyphs wants one of these: a single face, not a family with fallback
     * behind it, which is exactly the point — there is nothing for it to fall
     * back to and nothing it can quietly substitute.
     */
    @Synchronized
    fun font(context: Context, page: Int): android.graphics.fonts.Font? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        fonts[page]?.let { return it }
        return try {
            val f = android.graphics.fonts.Font.Builder(context.assets, "p$page.ttf").build()
            fonts[page] = f
            f
        } catch (e: Exception) {
            null
        }
    }

    /**
     * The surah names, which are one face for the whole book rather than one
     * per page: the 114 names and the word سورة, drawn in the mushaf's own
     * ornamental hand.
     *
     * A name is addressed by reading the surah's number as though it were
     * written in hexadecimal — 4 is E004, 10 is E010, 114 is E114 — which is
     * how the web reader addresses it, and how the face was numbered. The word
     * سورة sits at E000, just below the names. Private-use codepoints, these,
     * so nothing reads a script in them.
     *
     * Held for good once read. It is 150 kB and every page wants it.
     */
    @Synchronized
    fun names(context: Context): Glyphs? {
        nameTable?.let { return it }
        nameTable = read(context, "gsura-names.txt")
        return nameTable
    }

    @Synchronized
    fun nameFace(context: Context): android.graphics.fonts.Font? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        nameFont?.let { return it }
        nameFont = try {
            android.graphics.fonts.Font.Builder(context.assets, "sura-names.ttf").build()
        } catch (e: Exception) {
            null
        }
        return nameFont
    }

    /** The same face as a Typeface, for phones that cannot draw by number. */
    @Synchronized
    fun nameTypeface(context: Context): Typeface? {
        nameFamily?.let { return it }
        nameFamily = try {
            Typeface.createFromAsset(context.assets, "sura-names.ttf")
        } catch (e: RuntimeException) {
            null
        }
        return nameFamily
    }

    /** Where a surah's name is written in that face. */
    fun nameCode(surah: Int): Int = 0xE000 + Integer.parseInt(surah.toString().padStart(3, '0'), 16)

    /** The word سورة, in the same hand as the names. */
    const val SURAH_WORD = 0xE000

    /** Let go of what belongs to pages the reader has left behind. */
    @Synchronized
    fun keepOnly(near: IntRange) {
        /* The Basmalah's page is kept whatever the reader is looking at: a
           surah can open on any page, and its face is what draws the four
           words when one does. */
        fun spare(p: Int) = p in near || p == basmalahPage

        val f = faces.keys.iterator()
        while (f.hasNext()) if (!spare(f.next())) f.remove()

        val o = fonts.keys.iterator()
        while (o.hasNext()) if (!spare(o.next())) o.remove()

        val t = tables.keys.iterator()
        while (t.hasNext()) if (!spare(t.next())) t.remove()

        /* The lines are small, so a wider net: a reader turning back and forth
           over a few pages should not pay to read them again each time. */
        val wide = (near.first - 8)..(near.last + 8)
        val l = parsed.keys.iterator()
        while (l.hasNext()) if (l.next() !in wide) l.remove()
    }
}
