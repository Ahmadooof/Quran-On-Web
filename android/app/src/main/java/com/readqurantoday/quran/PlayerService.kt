package com.readqurantoday.quran

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat as MediaCompat

/**
 * A foreground service that keeps the player notification alive while a
 * recitation is running, even with the app in the background.
 *
 * The service itself does no playback — ExoPlayer lives in Recite and keeps
 * running whether or not any screen is open. The service only manages the
 * notification that lets the listener pause, resume, or stop from the shade
 * and the lock screen without opening the app.
 *
 * It is started by Recite.start() and stopped by Recite.stop(). Tapping
 * play/pause or stop in the notification sends an intent back to the service,
 * which delegates straight to Recite.
 */
class PlayerService : Service() {

    private lateinit var session: MediaSessionCompat
    private var surahId = 0

    companion object {
        private const val CHANNEL = "quran_player"
        private const val NOTIF_ID = 1001

        private const val ACTION_TOGGLE = "com.readqurantoday.quran.player.TOGGLE"
        private const val ACTION_STOP   = "com.readqurantoday.quran.player.STOP"
        private const val EXTRA_SURAH   = "surah_id"

        /**
         * Start the notification, or refresh it if the service is already up.
         * Safe to call on every state change — it is a no-op when the surah is 0.
         */
        fun show(context: Context, surah: Int) {
            if (surah <= 0) return
            val intent = Intent(context, PlayerService::class.java)
                .putExtra(EXTRA_SURAH, surah)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
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
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TOGGLE -> {
                Recite.toggle()
                refresh()
            }
            ACTION_STOP -> {
                Recite.stop()   /* stop() calls dismiss(), which calls stopService() */
            }
            else -> {
                val sid = intent?.getIntExtra(EXTRA_SURAH, 0) ?: 0
                if (sid > 0) surahId = sid
                val notif = buildNotification()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(
                        NOTIF_ID, notif,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                    )
                } else {
                    startForeground(NOTIF_ID, notif)
                }
                refreshSession()
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        session.release()
    }

    /* ------------------------------------------------------------------ */

    /** Push a fresh notification without restarting the service. */
    fun refresh() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification())
        refreshSession()
    }

    private fun surahName(): String {
        val s = Surahs.list().firstOrNull { it.id == surahId } ?: return ""
        return getString(R.string.surah_named, s.name)
    }

    private fun buildNotification(): Notification {
        val playing = Recite.wantsToPlay()

        /* Tapping the notification reopens the reader. */
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, ReaderActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val toggleIntent = PendingIntent.getService(
            this, 1,
            Intent(this, PlayerService::class.java).setAction(ACTION_TOGGLE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = PendingIntent.getService(
            this, 2,
            Intent(this, PlayerService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_play)
            .setContentTitle(surahName())
            .setContentIntent(openIntent)
            .setOngoing(playing)
            .setShowWhen(false)
            .setSilent(true)
            .addAction(
                if (playing) R.drawable.ic_pause else R.drawable.ic_play,
                if (playing) getString(R.string.stop) else getString(R.string.play),
                toggleIntent
            )
            .addAction(R.drawable.ic_stop, getString(R.string.close), stopIntent)
            .setStyle(
                MediaCompat.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(0, 1)
            )
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun refreshSession() {
        val state = PlaybackStateCompat.Builder()
            .setState(
                if (Recite.wantsToPlay()) PlaybackStateCompat.STATE_PLAYING
                else PlaybackStateCompat.STATE_PAUSED,
                Recite.at().toLong(),
                1f
            )
            .setActions(
                PlaybackStateCompat.ACTION_PLAY_PAUSE or
                PlaybackStateCompat.ACTION_STOP
            )
            .build()
        session.setPlaybackState(state)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL) != null) return
            NotificationChannel(
                CHANNEL,
                getString(R.string.app_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                setShowBadge(false)
            }.also { nm.createNotificationChannel(it) }
        }
    }
}
