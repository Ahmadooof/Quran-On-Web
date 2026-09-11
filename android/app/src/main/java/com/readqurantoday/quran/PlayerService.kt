package com.readqurantoday.quran

import android.app.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat as MediaCompat

/**
 * A foreground service that keeps the player notification alive while a
 * recitation is running, even with the app fully in the background.
 *
 * The service does no playback — ExoPlayer lives in Recite. It only manages
 * the notification that lets the listener control playback from the shade and
 * the lock screen.
 *
 * Notification actions are handled by an inner BroadcastReceiver rather than
 * through onStartCommand(), so there is no risk of a queued start-command
 * racing against a notification rebuild.
 */
class PlayerService : Service() {

    private lateinit var session: MediaSessionCompat
    private var surahId = 0

    private val actionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_TOGGLE -> { Recite.toggle(); updateNotification() }
                ACTION_STOP   -> Recite.stop()   /* stop() calls dismiss() */
            }
        }
    }

    companion object {
        private const val CHANNEL  = "quran_player"
        const val NOTIF_ID = 1001

        private const val ACTION_TOGGLE = "com.readqurantoday.quran.player.TOGGLE"
        private const val ACTION_STOP   = "com.readqurantoday.quran.player.STOP"
        private const val EXTRA_SURAH   = "surah_id"

        /**
         * Start the notification, or refresh it if the service is already up.
         * Safe to call on every state change; no-op when surah is 0.
         */
        fun show(context: Context, surah: Int) {
            if (surah <= 0) return
            val intent = Intent(context, PlayerService::class.java)
                .putExtra(EXTRA_SURAH, surah)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                context.startForegroundService(intent)
            else
                context.startService(intent)
        }

        /** Take the notification down and stop the service. */
        fun dismiss(context: Context) {
            context.stopService(Intent(context, PlayerService::class.java))
        }
    }

    override fun onCreate() {
        super.onCreate()
        Surahs.load(this)
        createChannel()
        session = MediaSessionCompat(this, "QuranPlayer").also { it.isActive = true }

        /* Receive toggle/stop from notification buttons inside this process only. */
        val filter = IntentFilter().apply {
            addAction(ACTION_TOGGLE)
            addAction(ACTION_STOP)
        }
        ContextCompat.registerReceiver(
            this, actionReceiver, filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val sid = intent?.getIntExtra(EXTRA_SURAH, 0) ?: 0
        if (sid > 0) surahId = sid

        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIF_ID, notif)
        }
        updateSession()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        try { unregisterReceiver(actionReceiver) } catch (_: Exception) {}
        session.release()
    }

    /* ------------------------------------------------------------------ */

    /** Rebuild and post the notification in place (no service restart needed). */
    fun updateNotification() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification())
        updateSession()
    }

    private fun surahName(): String {
        val s = Surahs.list().firstOrNull { it.id == surahId } ?: return ""
        return getString(R.string.surah_named, s.name)
    }

    private fun buildNotification(): Notification {
        val playing = Recite.wantsToPlay()
        val name    = surahName()

        /* Tapping the notification body reopens the reader. */
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, ReaderActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        /* Action buttons go to the BroadcastReceiver, not onStartCommand. */
        val togglePi = PendingIntent.getBroadcast(
            this, 1,
            Intent(ACTION_TOGGLE).setPackage(packageName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopPi = PendingIntent.getBroadcast(
            this, 2,
            Intent(ACTION_STOP).setPackage(packageName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_play)
            .setContentTitle(name)
            .setContentIntent(openIntent)
            .setOngoing(true)        /* always dismissible only via the stop action */
            .setShowWhen(false)
            .setSilent(true)
            .addAction(
                if (playing) R.drawable.ic_pause else R.drawable.ic_play,
                if (playing) getString(R.string.stop) else getString(R.string.play),
                togglePi
            )
            .addAction(R.drawable.ic_stop, getString(R.string.close), stopPi)
            .setStyle(
                MediaCompat.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(0, 1)
            )
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
    }

    private fun updateSession() {
        val name = surahName()
        /* Metadata is required for Android's QS media-player widget to appear
           on the first pull-down of the notification shade. */
        session.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, name)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST,
                    getString(R.string.app_name))
                .build()
        )
        session.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setState(
                    if (Recite.wantsToPlay()) PlaybackStateCompat.STATE_PLAYING
                    else PlaybackStateCompat.STATE_PAUSED,
                    Recite.at().toLong(), 1f
                )
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY_PAUSE or
                    PlaybackStateCompat.ACTION_STOP
                )
                .build()
        )
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL) != null) return
            NotificationChannel(
                CHANNEL,
                getString(R.string.app_name),
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                setShowBadge(false)
                setSound(null, null)      /* no sound despite DEFAULT importance */
                enableVibration(false)
            }.also { nm.createNotificationChannel(it) }
        }
    }
}
