package com.readqurantoday.quran

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import java.io.File

/**
 * Keeping a recitation on the phone.
 *
 * A surah at a time, because that is the unit a listener thinks in and because
 * a whole recitation is twenty or thirty hours — nobody wants all of it and
 * nobody should be made to take all of it to have some of it.
 *
 * The fetching is Android's own DownloadManager rather than anything written
 * here. It queues, it resumes a broken transfer, it survives the app being
 * closed, and it shows the progress in the shade where a phone's owner already
 * looks for it. A hand-rolled downloader would be all of that again, worse.
 *
 * The files go in the app's own external directory, so they are counted against
 * this app in the phone's storage settings and go when it does — which is what
 * a reader who wants the space back would expect.
 */
object Downloads {

    /** Where a surah is kept, once it is. */
    fun file(context: Context, surah: Int, reciter: String): File {
        val dir = File(context.getExternalFilesDir("audio"), reciter)
        return File(dir, surah.toString().padStart(3, '0') + ".mp3")
    }

    /**
     * Is this surah on the phone, whole?
     *
     * Not merely "is there a file". The download manager writes into the file
     * it will end at, so the moment a fetch begins there is a file of a few
     * kilobytes sitting where the finished recording will be — and taken for
     * the recording, it was played: a truncated stream whose length is wrong,
     * which cannot be sought within past the part that has arrived, and which
     * therefore leaves the light nowhere near what is being said. That is the
     * whole of "the highlighting is wrong for this reciter" for any surah that
     * happened to be coming down at the time.
     *
     * So a fetch still in flight is not a copy yet.
     */
    fun has(context: Context, surah: Int, reciter: String) =
        file(context, surah, reciter).let { it.exists() && it.length() > 0 } &&
            !fetching(context, surah, reciter)

    /* What is in flight, by surah and voice. Held only in memory: a download
       that outlives the app finishes on its own and is then simply a file. */
    private val running = HashMap<String, Long>()

    private fun key(surah: Int, reciter: String) = "$reciter/$surah"

    /**
     * Is this surah still coming down?
     *
     * Asked of the download manager by where the bytes are going rather than
     * by the id we were given when we asked for them. The id lives in this
     * process and a download does not: it is a system service, it carries on
     * with the app closed, and the next time the app is opened the file is
     * half there and the id that would have said so is gone. Matching on the
     * destination is the same question asked in a way that survives that.
     */
    fun fetching(context: Context, surah: Int, reciter: String): Boolean {
        val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val target = file(context, surah, reciter)

        val moving = DownloadManager.Query().setFilterByStatus(
            DownloadManager.STATUS_PENDING or DownloadManager.STATUS_RUNNING or
                DownloadManager.STATUS_PAUSED
        )
        try {
            manager.query(moving)?.use { c ->
                val column = c.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI)
                while (c.moveToNext()) {
                    val where = if (column >= 0) c.getString(column) else null
                    if (where != null && sameFile(where, target)) return true
                }
            }
        } catch (e: Exception) {
            // an unreadable download database says nothing either way
        }

        /* Nothing in flight, so anything we were told about is over. */
        running.remove(key(surah, reciter))
        return false
    }

    /** The manager names its destination as a uri; ours is a path. */
    private fun sameFile(uri: String, target: File): Boolean {
        val path = try {
            Uri.parse(uri).path
        } catch (e: Exception) {
            null
        } ?: return false
        return File(path).absolutePath == target.absolutePath
    }

    /** Is anything at all still coming down? */
    fun busy(context: Context) = running.keys.toList().any { k ->
        val parts = k.split('/')
        fetching(context, parts[1].toInt(), parts[0])
    }

    /** Fetch a surah in this voice, unless it is here or already coming. */
    fun start(context: Context, surah: Int, reciter: String) {
        if (has(context, surah, reciter) || fetching(context, surah, reciter)) return

        val target = file(context, surah, reciter)
        target.parentFile?.mkdirs()

        val request = DownloadManager.Request(Uri.parse(Recite.urlFor(context, surah, reciter)))
            .setTitle(context.getString(R.string.app_name))
            .setDescription(context.getString(R.string.page_named, surah))
            .setDestinationUri(Uri.fromFile(target))
            .setAllowedOverRoaming(false)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)

        val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        running[key(surah, reciter)] = manager.enqueue(request)
    }

    /** Give the space back. */
    fun remove(context: Context, surah: Int, reciter: String) {
        file(context, surah, reciter).delete()
    }
}
