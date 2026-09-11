package com.readqurantoday.quran

import android.content.Context
import org.json.JSONObject

/**
 * When each ayah and each word is said, for one surah in one voice.
 *
 * These files already ship with the app — they are what tells the reader which
 * audio file to fetch — and they carry rather more than that: the millisecond
 * each ayah begins and ends, and inside each ayah, the millisecond each word is
 * reached. That is everything needed to light the word being recited, with no
 * listening to the audio and no guessing from its length.
 *
 * An ayah's words arrive as one flat run of pairs — time, word, time, word —
 * which is how the file is written and is also the right shape for the question
 * actually asked of it: given a moment, which word is being said. Reading it as
 * pairs and walking forward is cheaper than any structure built over it, and
 * this is asked twenty times a second.
 */
class Timing private constructor(
    /** Where each ayah starts and ends: [start, end] in milliseconds. */
    val ayat: List<IntArray>,
    /** Per ayah, a flat run of time and word-number pairs. */
    private val words: List<IntArray>
) {

    /** How many ayahs this surah has, by the timing's reckoning. */
    val count get() = ayat.size

    /**
     * Which ayah is being said at this moment.
     *
     * The ayahs do not butt up against one another: a reciter pauses at the end
     * of each, and that pause belongs to no ayah's span. It is not a small
     * thing — over Al-Baqarah alone it comes to a minute of silence in most of
     * these recordings and four minutes in one of them, and a single pause runs
     * to eight seconds in another. Answering "none" in those gaps put the light
     * out after every ayah, for a moment or for most of a second, and the
     * longer a reciter pauses the worse it looked.
     *
     * So the pause after an ayah is still that ayah's, and the light rests
     * where the reciter left it rather than going out. That is what the web
     * reader does, and it is why this cannot simply be a search for a span that
     * contains the moment.
     *
     * @param was the answer last time, which is nearly always this one or the
     *   next: recitation goes forwards, and this is asked twenty times a second.
     */
    @JvmOverloads
    fun ayahAt(ms: Int, was: Int = 0): Int {
        if (ayat.isEmpty()) return 0

        if (was in 1..ayat.size) {
            val i = was - 1
            if (ms >= ayat[i][0] && ms < ayat[i][1]) return was
            if (i + 1 < ayat.size && ms >= ayat[i + 1][0] && ms < ayat[i + 1][1]) return was + 1
        }

        var lo = 0
        var hi = ayat.size - 1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            when {
                ms < ayat[mid][0] -> hi = mid - 1
                ms >= ayat[mid][1] -> lo = mid + 1
                else -> return mid + 1
            }
        }
        /* Between two ayahs, or before the first: the one just ended, or the
           one about to begin. */
        return lo.coerceIn(1, ayat.size)
    }

    /**
     * Which word of this ayah is being said, or -1.
     *
     * Two things about the file this reads, both of which it got wrong before:
     *
     * The times inside an ayah are counted from that ayah's own beginning, not
     * from the beginning of the recording. Handed the moment on the recording's
     * clock, nothing ever matched and no word was ever lit.
     *
     * And they are not in order. A reciter does not only go forwards — in some
     * two dozen ayahs of Al-Baqarah this one doubles back over a phrase and
     * says it again — so the run is walked from the end and the last entry
     * whose time has passed is the answer. Stopping at the first entry that
     * lies ahead would stop at the doubling back.
     */
    fun wordAt(ayah: Int, ms: Int): Int {
        val run = words.getOrNull(ayah - 1) ?: return -1
        if (run.isEmpty()) return -1

        val since = ms - startOf(ayah)
        var i = run.size - 2
        while (i >= 0) {
            if (since >= run[i]) return run[i + 1]
            i -= 2
        }
        return run[1]
    }

    /**
     * Where one word sits in the recitation, on the recording's own clock.
     *
     * The first time it is said, where it is said more than once: that is the
     * one the reader pointed at. It ends where the next word begins, and the
     * last word of an ayah runs to the end of the ayah — which hands it the
     * pause the reciter takes there, and that pause is part of how the word
     * sounds.
     */
    fun wordSpan(ayah: Int, word: Int): IntArray? {
        val run = words.getOrNull(ayah - 1) ?: return null
        val opens = startOf(ayah)

        var i = 0
        while (i + 1 < run.size) {
            if (run[i + 1] == word) {
                val from = opens + run[i]
                val to = if (i + 2 < run.size) opens + run[i + 2] else endOf(ayah)
                return intArrayOf(from, to)
            }
            i += 2
        }
        return null
    }

    /** Where an ayah begins, for seeking to it. */
    fun startOf(ayah: Int) = ayat.getOrNull(ayah - 1)?.get(0) ?: 0

    fun endOf(ayah: Int) = ayat.getOrNull(ayah - 1)?.get(1) ?: 0

    companion object {

        private val held = HashMap<String, Timing?>()

        /** The timings for a surah in a voice, or null if there are none. */
        @Synchronized
        fun of(context: Context, surah: Int, reciter: String): Timing? {
            val key = "$reciter/$surah"
            if (held.containsKey(key)) return held[key]

            val timing = try {
                val padded = surah.toString().padStart(3, '0')
                val asset = "surah/$surah/$padded.$reciter.timing.json"
                val text = context.assets.open(asset).use { it.readBytes() }
                read(JSONObject(String(text, Charsets.UTF_8)))
            } catch (e: Exception) {
                null
            }

            /* Kept even when there is nothing, so a surah with no timings is
               not looked for again on every frame. */
            held[key] = timing
            return timing
        }

        /**
         * One ayah's words, put back in the order they are said.
         *
         * A run is allowed to go backwards: a reciter who repeats a phrase
         * repeats its word numbers with it, and that is the format doing its
         * job. What is not allowed is a run in which a word is named for the
         * first time after a later one has already been and gone — a reciter
         * cannot say the second word before the first.
         *
         * Where that happens and no word is named twice, the numbering is
         * simply wrong and the times are all there is to go on: eight segments
         * for eight words, in the order they are spoken. Then the k-th moment
         * is the k-th word, and relabelling them says so. In Al-Baqarah 5 the
         * file has them 2,3,4,5,6,7,8,1 — so the light began on the second word
         * and only reached the first as the ayah ended, which is the ayah
         * highlighting itself backwards.
         *
         * A run with a genuine repeat in it is left exactly as it is: there the
         * order is evidence, not a mistake, and nothing here can tell which of
         * the two readings was meant.
         */
        private fun ordered(run: IntArray): IntArray {
            val n = run.size / 2
            if (n < 2) return run

            val idx = IntArray(n) { run[it * 2 + 1] }
            val seen = idx.toHashSet()
            /* A word said twice: a repeat, and none of this applies. */
            if (seen.size != n) return run
            /* Anything but a plain 0..n-1 between them is a run this cannot
               read, and guessing at it would be worse than leaving it. */
            for (k in 0 until n) if (!seen.contains(k)) return run

            var sound = true
            for (k in 1 until n) if (idx[k] < idx[k - 1]) { sound = false; break }
            if (sound) return run

            /* By the clock, then: the earliest moment is the first word. */
            val order = (0 until n).sortedBy { run[it * 2] }
            val out = IntArray(run.size)
            for (k in 0 until n) {
                out[k * 2] = run[order[k] * 2]
                out[k * 2 + 1] = k
            }
            return out
        }

        private fun read(root: JSONObject): Timing {
            val spans = ArrayList<IntArray>()
            root.optJSONArray("ayah")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val a = arr.getJSONArray(i)
                    spans.add(intArrayOf(a.getInt(0), a.getInt(1)))
                }
            }

            val runs = ArrayList<IntArray>()
            root.optJSONArray("word")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val a = arr.getJSONArray(i)
                    runs.add(ordered(IntArray(a.length()) { a.getInt(it) }))
                }
            }

            return Timing(spans, runs)
        }
    }
}
