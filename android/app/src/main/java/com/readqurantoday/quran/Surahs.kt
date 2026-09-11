package com.readqurantoday.quran

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The 114 surahs, and the two questions the reader keeps asking of them:
 * where does this one start, and which one is this page in.
 */
object Surahs {

    data class Surah(
        val id: Int,
        val name: String,      // الفاتحة
        val english: String,   // Al-Fatihah
        val ayahs: Int,
        val from: Int,         // first page
        val to: Int            // last page
    )

    private val all = ArrayList<Surah>(114)

    /** The page each juz opens on, from mushaf.json: 30 of them. */
    private var juz = IntArray(0)

    fun load(context: Context) {
        if (all.isNotEmpty()) return

        /* The file is a plain array of surahs — not an object with an array
           inside it, which is what this asked for at first and crashed on. */
        val text = context.assets.open("data/surahs.json").use { it.readBytes() }
        val arr = JSONArray(String(text, Charsets.UTF_8))

        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            all.add(
                Surah(
                    id = o.getInt("id"),
                    name = o.getString("name"),
                    english = o.optString("en"),
                    ayahs = o.optInt("v"),
                    from = o.getInt("from"),
                    to = o.getInt("to")
                )
            )
        }

        val mushaf = context.assets.open("data/mushaf.json").use { it.readBytes() }
        val pages = JSONObject(String(mushaf, Charsets.UTF_8)).optJSONArray("juzPages")
        if (pages != null) juz = IntArray(pages.length()) { pages.getInt(it) }
    }

    fun list(): List<Surah> = all

    /**
     * Which surah a page belongs to.
     *
     * A page can hold the end of one surah and the beginning of the next; the
     * running head names the one that ends there, which is the last whose first
     * page is this page or earlier. That is what the printed head does.
     */
    fun ofPage(page: Int): Surah? {
        var found: Surah? = null
        for (s in all) {
            if (s.from <= page) found = s else break
        }
        return found
    }

    /** Which juz a page is in — 1 to 30, or 0 before the list is loaded. */
    fun juzOfPage(page: Int): Int {
        var n = 0
        for (i in juz.indices) if (juz[i] <= page) n = i + 1 else break
        return n
    }
}
