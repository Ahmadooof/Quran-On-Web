package com.readqurantoday.quran

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import org.json.JSONObject

/**
 * The recitations: who reads, and the playing of it.
 *
 * One player for the whole app, held here rather than in a screen, because
 * listening outlives the screen that started it — a reciter is put on in the
 * menu and then read along with in the mushaf.
 *
 * The audio itself is not in the package and never could be: the recordings run
 * to tens of hours apiece. It is streamed from the bucket the website plays
 * from, and which file is which comes out of the timing data that already ships
 * with the app — every surah's timing file names its own audioPath, so nothing
 * here has to guess at a filename.
 */
object Recite {

    /** Where the recordings are served from. */
    private const val BUCKET = "https://audio.readqurantoday.com"

    data class Reciter(val id: String, val name: String, val nameAr: String, val noteAr: String)

    private val all = ArrayList<Reciter>()
    private var fallback = ""

    private var player: MediaPlayer? = null

    /* Kept so the recitation can carry on into the next surah without a screen
       to ask for it: the listener may well have put the phone down. */
    private var app: Context? = null

    /* Where the recitation was asked to be, until it is there.
     *
     * A player is not ready the moment it is made. The recording is streamed,
     * so start() hands the file over and returns, the preparing happens on
     * another thread, and the seek to the ayah that was asked for cannot even
     * be made until that is done. In between, the player answers "nought" when
     * asked where it is — and nought is the first word of the first ayah of
     * the surah.
     *
     * That is the whole of the bug it caused: play an ayah, and the light went
     * to the top of the surah and the page turned there, and a moment later
     * both jumped to the ayah actually being played. A seek within a stream is
     * the same story more briefly — the position asked for is not the position
     * reported until the player has fetched the bytes around it.
     *
     * So what was asked for is remembered, and it is what at() answers with
     * until the player has caught up with it. Nothing that follows the
     * recitation has to know any of this. */
    private var wanted = -1

    /** Ready to be told where to go. */
    private var prepared = false

    /* The listener pressed play while the player was still preparing. Remembered
       so that onPreparedListener can start it rather than dropping the tap. */
    private var pendingPlay = false

    /* A seek was needed on prepare, and play was also requested. Start() must
       wait until onSeekComplete fires, because seekTo() is asynchronous —
       calling start() right after seekTo() plays from position 0, not from
       the word that was asked for. */
    private var pendingStart = false

    /**
     * How far the player's own reckoning runs behind what is coming out of the
     * speaker, in milliseconds.
     *
     * It does run behind, and by a fixed amount. Measured rather than guessed:
     * a surah was played from a known point to the end of the file, and the
     * time it took was compared with the length of recording that was left.
     * The audio took 18704 ms of real time to play 18571 ms of recording — a
     * tenth of a second of that being the delay before the sound started — but
     * over the same stretch getCurrentPosition advanced only 18232 ms. It had
     * lost 339 ms, and it had lost them at the beginning: the rate is exact
     * afterwards, 71117 ms of recording in 71118 ms of real time over a minute
     * of playing. Twice run, the same figure to the millisecond.
     *
     * That is the audio pipeline: what the player reports is where the decoder
     * has got to, and the sound of it is still working its way through the
     * buffers under it. So the word being *said* is the one a third of a second
     * further on than the word the player is pointing at — which is exactly the
     * fault this fixes: the voice arriving first and the light following it.
     */
    private const val BEHIND = 339

    /** The surah being played, or 0. */
    var playing = 0
        private set

    /** Told whenever the player starts, stops or is made ready. */
    var onChange: (() -> Unit)? = null

    /** What to do at the end of what is being recited. */
    const val ONCE = 0
    const val AYAH = 1
    const val SURAH = 2

    var repeat = ONCE

    /**
     * Where in the recording it is, in milliseconds.
     *
     * Where it was asked to be, rather, until it is there: see `wanted`. The
     * two are the same the whole of the time nothing has just been asked for,
     * which is nearly always.
     */
    fun at(): Int {
        if (wanted >= 0 && !prepared) return wanted

        val now = try {
            player?.currentPosition ?: 0
        } catch (e: IllegalStateException) {
            0
        }

        if (wanted >= 0) {
            /* Arrived. A seek lands on a frame rather than on the millisecond
               it was given, so near enough is arrived. */
            if (kotlin.math.abs(now - wanted) < 500) {
                wanted = -1
                return heard(now)
            }
            return wanted
        }
        return heard(now)
    }

    /**
     * The moment of the recording that is being heard, from the moment the
     * player says it is at.
     *
     * Only while it is running. Stopped, there is nothing in the buffers to be
     * behind: the sound the listener last heard is the position the player is
     * standing at, and a paused light should sit on the word that was reached
     * rather than on the one after it.
     */
    private fun heard(now: Int) = if (isPlaying()) now + BEHIND else now

    /** Send the recitation somewhere, and remember that it is on its way. */
    fun seek(ms: Int) {
        wanted = ms.coerceAtLeast(0)
        if (!prepared) return          // the preparing will do it
        try {
            player?.seekTo(wanted)
        } catch (e: IllegalStateException) {
            // the player was let go of between the asking and the doing
        }
    }

    fun load(context: Context) {
        if (all.isNotEmpty()) return
        val text = context.assets.open("data/recitations.json").use { it.readBytes() }
        val root = JSONObject(String(text, Charsets.UTF_8))
        fallback = root.optString("default")

        val list = root.optJSONArray("recitations") ?: return
        for (i in 0 until list.length()) {
            val o = list.getJSONObject(i)
            all.add(
                Reciter(
                    id = o.getString("id"),
                    name = o.optString("name"),
                    nameAr = o.optString("nameAr"),
                    noteAr = o.optString("noteAr")
                )
            )
        }
    }

    fun reciters(): List<Reciter> = all

    /** The chosen recitation, or the one a listener who has never chosen gets. */
    fun chosen(context: Context): Reciter? {
        val id = Settings.reciter(context) ?: fallback
        return all.firstOrNull { it.id == id } ?: all.firstOrNull()
    }

    /**
     * Remember who is to read. Nothing else.
     *
     * It used to start the recitation again here, from the top, which was wrong
     * in every case that matters: the caller knows where the listener is and
     * whether they were paused, and this does not. Both callers went on to
     * start it properly a moment later, so the recording was fetched twice and
     * the first of the two played from the beginning before being thrown away.
     */
    fun choose(context: Context, id: String) {
        Settings.setReciter(context, id)
    }

    /** Loaded, but not going: paused rather than stopped. */
    fun paused() = playing != 0 && !isPlaying()

    /**
     * Where this surah is on the bucket.
     *
     * Out of the timing file, which names it: the same recording can be filed
     * under a folder that is not simply the recitation's id, and the timings
     * are the one place that already knows. If there is no timing file the
     * usual shape is assumed, which is better than refusing to play.
     */
    fun urlFor(context: Context, surah: Int, reciter: String): String {
        val padded = surah.toString().padStart(3, '0')
        val path = try {
            val asset = "surah/$surah/$padded.$reciter.timing.json"
            val text = context.assets.open(asset).use { it.readBytes() }
            JSONObject(String(text, Charsets.UTF_8)).optString("audioPath")
        } catch (e: Exception) {
            ""
        }
        return "$BUCKET/" + (if (path.isNotEmpty()) path else "$reciter/$padded.mp3")
    }

    /** Play a surah, in the chosen voice, from a given moment. */
    @JvmOverloads
    fun start(context: Context, surah: Int, from: Int = 0, andPlay: Boolean = true) {
        if (surah <= 0) return
        val voice = chosen(context) ?: return
        stop()

        app = context.applicationContext
        playing = surah
        wanted = from.coerceAtLeast(0)
        prepared = false
        player = MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .build()
            )
            setOnPreparedListener { mp ->
                prepared = true
                /* Where it was asked to be, which may no longer be where it was
                   asked to be when it was made: the listener can press on to
                   the next ayah while the recording is still being fetched. */
                val shouldStart = andPlay || pendingPlay
                pendingPlay = false
                if (wanted > 0) {
                    /* seekTo() is asynchronous — start() must wait for the seek
                       to complete, or the audio begins at position 0 instead of
                       the word that was asked for. Defer start() to
                       onSeekCompleteListener via pendingStart. */
                    pendingStart = shouldStart
                    mp.seekTo(wanted)
                } else {
                    wanted = -1
                    if (shouldStart) mp.start()
                }
                onChange?.invoke()
            }
            setOnSeekCompleteListener { mp ->
                wanted = -1
                if (pendingStart) {
                    pendingStart = false
                    mp.start()
                    onChange?.invoke()
                }
            }
            setOnCompletionListener {
                /* A surah set to repeat begins again rather than ending. */
                if (repeat == SURAH) {
                    wanted = 0
                    it.seekTo(0)
                    it.start()
                    onChange?.invoke()
                    return@setOnCompletionListener
                }

                /* The recording has run out, and the Quran has not. Reading
                   goes on to the next surah the way it does on paper, without
                   being asked and without anyone having to pick the phone up
                   to ask for it. Only the last surah ends. */
                val next = playing + 1
                val where = app
                if (next in 2..114 && where != null) {
                    start(where, next, 0, true)
                } else {
                    stop()
                }
            }
            setOnErrorListener { _, _, _ -> stop(); true }
            /* A kept copy if there is a whole one, and the bucket if there is
               not. Whole matters: half a recording plays as a recording that
               is simply shorter, and everything said about where the words
               fall in it is then wrong. */
            val kept = Downloads.file(context, surah, voice.id)
            try {
                setDataSource(
                    if (Downloads.has(context.applicationContext, surah, voice.id)) kept.absolutePath
                    else urlFor(context.applicationContext, surah, voice.id)
                )
            } catch (e: Exception) {
                release()
                playing = 0
                onChange?.invoke()
                return
            }
            try {
                prepareAsync()
            } catch (e: Exception) {
                /* Nothing to play, so nothing is playing: better to say so than
                   to leave a dead player behind that every button talks to. */
                stop()
                return
            }
        }
        onChange?.invoke()
    }

    /** Pause what is playing, or take it up again. */
    fun toggle() {
        val p = player ?: return
        if (!prepared) {
            /* Still preparing: can't call start() yet (IllegalStateException).
               Remember the request so onPreparedListener can act on it. */
            pendingPlay = !pendingPlay
            return
        }
        if (p.isPlaying) {
            p.pause()
            pendingStart = false
        } else if (wanted >= 0) {
            /* Prepared but seek still in flight — defer start until the seek
               lands, the same way onPreparedListener does. */
            pendingStart = !pendingStart
        } else {
            p.start()
        }
        onChange?.invoke()
    }

    fun isPlaying() = player?.isPlaying == true

    fun stop() {
        player?.release()
        player = null
        playing = 0
        wanted = -1
        prepared = false
        pendingPlay = false
        pendingStart = false
        onChange?.invoke()
    }
}
