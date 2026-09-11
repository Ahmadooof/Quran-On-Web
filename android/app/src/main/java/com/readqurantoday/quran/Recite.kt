package com.readqurantoday.quran

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
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

    private var player: ExoPlayer? = null

    /* Kept so the recitation can carry on into the next surah without a screen
       to ask for it: the listener may well have put the phone down. */
    private var app: Context? = null

    /* Where the recitation was asked to be, until it is there.
     *
     * ExoPlayer reflects seekTo() in currentPosition quickly, but not always in
     * the same event-loop tick. Until currentPosition has caught up, returning
     * wanted keeps the follower on the right word and prevents a frame where the
     * light jumps to the beginning of the surah and back. */
    private var wanted = -1

    /**
     * How far the player's own reckoning runs behind what is coming out of the
     * speaker, in milliseconds.
     *
     * With MediaPlayer this was 339 ms — its currentPosition reported where the
     * decoder had got to, which was a third of a second ahead of what the audio
     * pipeline had actually delivered to the speaker.
     *
     * ExoPlayer uses AudioTrack.getTimestamp() (available from API 24, which is
     * this app's minimum) to report the rendered audio position — the moment
     * that is literally coming out of the speaker right now — so the pipeline
     * delay is already accounted for and no correction is needed here.
     */
    private const val BEHIND = 0

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
        val p = player ?: return if (wanted >= 0) wanted else 0

        val now = try {
            p.currentPosition.toInt()
        } catch (e: Exception) {
            0
        }

        if (wanted >= 0) {
            /* Arrived. A seek lands on a frame rather than on the millisecond
               it was given, so near enough is arrived. */
            if (kotlin.math.abs(now - wanted) < 500) {
                wanted = -1
                return if (isPlaying()) now + BEHIND else now
            }
            return wanted
        }
        return if (isPlaying()) now + BEHIND else now
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

    /** Send the recitation somewhere, and remember that it is on its way. */
    fun seek(ms: Int) {
        wanted = ms.coerceAtLeast(0)
        player?.seekTo(wanted.toLong())
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
     * The listener pressed play; the recording is on its way or already here.
     *
     * isPlaying() is only true while audio is literally coming out of the
     * speaker. During the brief buffering that follows a seek or a load,
     * isPlaying() is false even though the listener pressed play and expects
     * to hear something. This returns true for both cases — playing now, or
     * buffering towards a play — so the pause button and the follower stay
     * consistent with what the listener asked for, not with where the network
     * happens to be at this moment.
     */
    fun wantsToPlay() = playing != 0 && (player?.playWhenReady == true)

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
        if (from > 0) wanted = from

        val uri = if (Downloads.has(context.applicationContext, surah, voice.id))
            Uri.fromFile(Downloads.file(context, surah, voice.id))
        else Uri.parse(urlFor(context.applicationContext, surah, voice.id))

        player = ExoPlayer.Builder(context.applicationContext).build().apply {
            addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    /* The recording has run out. */
                    if (state == Player.STATE_ENDED) {
                        if (repeat == SURAH) {
                            seekTo(0)
                            play()
                            wanted = 0
                            onChange?.invoke()
                            return
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
                        return
                    }
                    onChange?.invoke()
                }

                override fun onPlayerError(error: PlaybackException) {
                    stop()
                }

                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    /* Keep the notification in sync with the actual play state
                       (buffering → playing, or playing → paused). */
                    app?.let { PlayerService.show(it, playing) }
                    onChange?.invoke()
                }
            })

            setMediaItem(MediaItem.fromUri(uri))

            /* Seek before prepare: ExoPlayer accepts a seek target before the
               file is ready and honours it the moment it arrives. This is the
               whole fix for the bug where the audio started from the beginning
               of the surah instead of the held word.

               MediaPlayer required seekTo() inside onPreparedListener, and even
               then it failed silently on VBR (variable-bit-rate) MP3 streams:
               without a fixed bitrate it cannot calculate byte offsets, so the
               seek completed without moving. ExoPlayer reads the MPEG frame
               headers directly and finds the right position in VBR files. */
            if (from > 0) seekTo(from.toLong())
            prepare()
            if (andPlay) play()
        }
        /* Start the foreground notification so playback survives backgrounding. */
        app?.let { PlayerService.show(it, surah) }
        onChange?.invoke()
    }

    /** Pause what is playing, or take it up again. */
    fun toggle() {
        val p = player ?: return
        /* ExoPlayer's play() sets playWhenReady = true. If the player is still
           buffering, it will start the moment it is ready — no pendingPlay flag
           needed. */
        if (p.isPlaying) p.pause() else p.play()
        app?.let { PlayerService.show(it, playing) }
        onChange?.invoke()
    }

    fun isPlaying() = player?.isPlaying == true

    fun stop() {
        val ctx = app
        val p = player
        player = null
        playing = 0
        wanted = -1
        p?.release()
        ctx?.let { PlayerService.dismiss(it) }
        onChange?.invoke()
    }
}
