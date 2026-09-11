package com.readqurantoday.quran

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.LinearSmoothScroller
import androidx.recyclerview.widget.PagerSnapHelper
import androidx.recyclerview.widget.RecyclerView

/**
 * The reader: 604 pages, turned by hand.
 *
 * Reading is the page and nothing else. Everything else — the bar, and the
 * phone's own bars at both ends of the screen — is away until the page is
 * tapped, and comes back together when it is. A screen this size holds one page
 * of this mushaf exactly, and anything standing on it is taken from the page.
 *
 * The bar says nothing about where you are: the page prints that across its own
 * head in the mushaf's hand, and saying it again in the phone's font would only
 * be saying it twice. What is on the bar is the two things the page cannot do
 * for itself — keep this page, and go back to the menu.
 */
class ReaderActivity : AppCompatActivity() {

    private val pages = 604

    private lateinit var pager: RecyclerView
    private lateinit var lanes: LinearLayoutManager
    private lateinit var bar: View
    private lateinit var mark: ImageView

    private var bars: WindowInsetsControllerCompat? = null
    private var chrome = false

    /* How much of the top of the screen belongs to the phone. Settled once, and
       then a constant for the life of the reader: everything about how a page
       is set follows from the height it is given. */
    private var band = 0
    private var bandSet = false

    private lateinit var player: View

    /* What is being recited, and the timings that say where in it we are. */
    private var reading: Timing? = null
    private var readingSurah = 0
    private var litAyah = 0

    /* Where the recitation is to stop, when only a word was asked for, and
       where it began — which is where a repeat sends it back to. */
    private var until = 0
    private var startedAt = 0

    /* The word asked for, when only a word was asked for. */
    private var litWord = -1

    /* Where the finger last was, so a long press knows what it was on. */
    private var lastTouchX = 0f
    private var lastTouchY = 0f

    /** The index hands back a page; the reader is what opens it. */
    private val fromIndex = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val page = result.data?.getIntExtra(SurahListActivity.PAGE, 0) ?: 0
            if (page in 1..pages) go(page)
        }
        /* Coming back from the menu is coming back to read. The top chrome
           goes away so the page is unobstructed, but if audio is playing the
           player bar stays — it was the reason the listener may have come
           back, and hiding it on arrival would be confusing. */
        showChrome(Recite.playing != 0)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Mushaf.load(this)
        Surahs.load(this)

        setContentView(R.layout.activity_reader)
        pager = findViewById(R.id.pager)
        bar = findViewById(R.id.bar)
        mark = findViewById(R.id.mark)

        dressWindow()
        buildPager()

        findViewById<View>(R.id.back).setOnClickListener { toMenu() }
        findViewById<View>(R.id.back_label).setOnClickListener { toMenu() }

        /* The ribbon keeps this page. It is on the bar rather than on the page
           because the page is the one thing nothing is allowed to sit on. */
        mark.setOnClickListener {
            Settings.toggleMark(this, page())
            sayMark(page())
        }

        player = findViewById(R.id.player)
        wirePlayer()

        val last = Settings.lastPage(this).let { if (it in 1..pages) it else 2 }
        go(last)
        sayMark(last)
        showChrome(false)

        /* The app opens on the menu, not on a page. Somebody coming back to the
           mushaf is usually going somewhere in particular, and the one who is
           not has the last page they read waiting at the top of it. The page
           behind is already the right one, so backing out of the menu lands
           where they left off rather than on nothing. */
        if (savedInstanceState == null) {
            fromIndex.launch(Intent(this, SurahListActivity::class.java))
        }
    }

    /**
     * The pages, laid side by side and snapped one at a time.
     *
     * A list with a snap helper rather than a ViewPager2, for one reason: how
     * long a page takes to settle after the finger leaves it. ViewPager2 owns
     * that animation and offers no say in it, and its default is a slow, soft
     * glide — right for a photo gallery, wrong for turning a page, which should
     * be over about as fast as paper. The helper below is the same machinery
     * with that one number in reach.
     */
    private fun buildPager() {
        lanes = LinearLayoutManager(this, RecyclerView.HORIZONTAL, false)
        pager.layoutManager = lanes
        pager.adapter = Pages()
        pager.setHasFixedSize(true)
        Snap().attachToRecyclerView(pager)

        pager.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            private var settled = -1

            override fun onScrollStateChanged(view: RecyclerView, state: Int) {
                if (state != RecyclerView.SCROLL_STATE_IDLE) return
                val at = lanes.findFirstCompletelyVisibleItemPosition()
                if (at == RecyclerView.NO_POSITION || at == settled) return
                settled = at

                val page = at + 1
                sayMark(page)
                Settings.setLastPage(this@ReaderActivity, page)
                /* Read what is coming before it is needed, and let go of what
                   is behind: a face is a memory-mapped file, and all 604 would
                   be 152 MB of them for pages nobody is reading. */
                Mushaf.warm(this@ReaderActivity, page)
                Mushaf.keepOnly((page - 3)..(page + 4))
            }
        })
    }

    /** A page turn, at the speed of a page turn. */
    private inner class Snap : PagerSnapHelper() {
        override fun createScroller(manager: RecyclerView.LayoutManager) =
            object : LinearSmoothScroller(this@ReaderActivity) {
                /* A quarter of the framework's own figure, which is 100. That
                   number is milliseconds per inch of travel, so this is four
                   times the speed: the page arrives rather than drifts in. */
                override fun calculateSpeedPerPixel(metrics: android.util.DisplayMetrics) =
                    25f / metrics.densityDpi

                override fun onTargetFound(target: View, state: RecyclerView.State, action: Action) {
                    val move = calculateDxToMakeVisible(target, SNAP_TO_START)
                    val time = calculateTimeForDeceleration(Math.abs(move))
                    if (time > 0) action.update(-move, 0, time.coerceAtMost(220), mDecelerateInterpolator)
                }
            }
    }

    private fun page() = (lanes.findFirstCompletelyVisibleItemPosition()
        .takeIf { it != RecyclerView.NO_POSITION } ?: 0) + 1

    private fun go(page: Int) {
        lanes.scrollToPositionWithOffset(page - 1, 0)
        Mushaf.warm(this, page)
    }

    private fun toMenu() = fromIndex.launch(Intent(this, SurahListActivity::class.java))

    /**
     * The window while reading: the page, edge to edge, and nothing else.
     *
     * Both of the phone's bars go, the one with the clock and camera in it as
     * well as the one at the foot — reading a mushaf is the whole screen or it
     * is a page with a phone around it. They come back with our own bar, all
     * three in the same colour, so a tap brings in one band of chrome and not
     * three different ones.
     */
    private fun dressWindow() {
        WindowCompat.setDecorFitsSystemWindows(window, false)

        /* The strip at the top of the screen — the clock, the camera — is not
           the page's to use. The window covers it, so that nothing resizes when
           the bars come and go, but the page is held below it and so is the
           bar: what shows up there is the window's own paper, always, whether
           the chrome is in or out.

           Measured once and then left alone. It was being recomputed whenever
           the insets changed, and the insets change every time the bars are
           asked for — so revealing the bar could grow this margin, which
           changes the height the fifteen lines are set in, which re-sizes the
           type. The page was reflowing under the reader's thumb. A page's
           measure is fixed the moment it is known and never touched again. */
        if (!bandSet) {
            bandSet = true
            band = topBand()
            pager.setPadding(0, band, 0, 0)
            liftBar()
        }

        ViewCompat.setOnApplyWindowInsetsListener(bar) { v, insets ->
            /* A camera that cuts deeper than the status bar is the taller of
               the two, and both the page and the bar yield to whichever it is —
               but only the first time, before anything has been drawn. */
            val cut = insets.displayCutout?.safeInsetTop ?: 0
            if (cut > band) {
                band = cut
                pager.setPadding(0, band, 0, 0)
                liftBar()
            }
            insets
        }

        bars = WindowInsetsControllerCompat(window, window.decorView).apply {
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    /** Is this screen dark at this moment? Asked, never remembered. */
    private fun night() =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    /** The bar's own contents clear the clock and the camera; its colour does not. */
    private fun liftBar() {
        val air = (8 * resources.displayMetrics.density).toInt()
        bar.setPadding(bar.paddingLeft, band + air, bar.paddingRight, air)
    }

    /**
     * A number as the app is currently written: Arabic figures in Arabic.
     *
     * The page has done this since it was first drawn; the player and the sheet
     * were still saying "الآية 5" with a Latin 5 in the middle of it.
     */
    private fun figures(n: Int): String {
        if (resources.configuration.locales[0].language != "ar") return n.toString()
        val out = StringBuilder()
        for (c in n.toString()) out.append(('\u0660' + (c - '0')))
        return out.toString()
    }

    /** How tall the phone's own buttons are at the foot of the screen. */
    private fun footBand(): Int {
        val id = resources.getIdentifier("navigation_bar_height", "dimen", "android")
        if (id > 0) return resources.getDimensionPixelSize(id)
        return (24 * resources.displayMetrics.density).toInt()
    }

    /** How tall the phone's top strip is, whether or not anything is in it. */
    private fun topBand(): Int {
        val id = resources.getIdentifier("status_bar_height", "dimen", "android")
        if (id > 0) return resources.getDimensionPixelSize(id)
        return (24 * resources.displayMetrics.density).toInt()
    }

    private fun showChrome(on: Boolean) {
        chrome = on
        bar.visibility = if (on) View.VISIBLE else View.GONE

        /* The player is chrome too. It is there when the chrome is and there is
           something to control, and away with everything else when the page is
           being read — a bar over the foot of a page is the same theft of the
           page as a bar over its head. */
        player.visibility = if (on && Recite.playing != 0) View.VISIBLE else View.GONE

        /* One colour for all of it. With the chrome in, the strip at the top,
           the bar and the foot of the screen are the same band; with it out,
           all three are the page's paper and the screen reads as one sheet. */
        val colour = getColor(if (on) R.color.chrome else R.color.paper)
        window.statusBarColor = colour
        window.navigationBarColor = colour

        /* Which way the clock and the phone's buttons are drawn: dark marks on
           a pale band, or pale on a dark one. Worked out here, every time,
           because the theme can have turned since this window was made. */
        bars?.isAppearanceLightStatusBars = !night()
        bars?.isAppearanceLightNavigationBars = !night()

        bars?.let {
            if (on) it.show(WindowInsetsCompat.Type.systemBars())
            else it.hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    /** The ribbon shows whether this page is one of the kept ones. */
    private fun sayMark(page: Int) {
        mark.setImageResource(
            if (Settings.marked(this, page)) R.drawable.ic_bookmark else R.drawable.ic_bookmark_off
        )
    }

    override fun onResume() {
        super.onResume()
        delegate.applyDayNight()
        sayMark(page())

        /* If the reciter or surah changed while we were in the menu, the
           follower's `reading` reference is stale: it still points at the old
           reciter's timing file, so every word is lit against the wrong
           millisecond table.
           Timing.of() is a cached lookup — it returns the same object for
           the same reciter+surah key, so a !== check tells us whether
           anything actually changed without doing extra work. */
        val nowSurah = Recite.playing
        if (nowSurah != 0) {
            val nowReading = Recite.chosen(this)?.id?.let { Timing.of(this, nowSurah, it) }
            if (nowSurah != readingSurah || nowReading !== reading) {
                readingSurah = nowSurah
                reading = nowReading
                /* Reset the highlight cursor so the follower finds the right
                   ayah from scratch on the very next tick. */
                litAyah = 0
                litWord = -1
                until = 0
            }
        }

        /* When the player finishes preparing and starts — whether because it
           was told to from the start, or because the listener pressed play
           while it was still loading — the follower has to know. */
        Recite.onChange = {
            if (Recite.wantsToPlay()) follow()
            sayPlayer()
        }
        sayPlayer()
    }

    override fun onPause() {
        super.onPause()
        Recite.onChange = null
    }

    /**
     * Say again what the window should look like, whenever it is listened to.
     *
     * Asking for the phone's bars to go away is only honoured while the window
     * has focus, and coming back from the menu is precisely a moment when it
     * has not got it yet — so the request made on the way in was dropped and
     * the bars stayed up over the page. Everything was put right by changing
     * the theme, which is not a fix but a rebuild: the activity was made again,
     * this time with focus, and the request stuck.
     *
     * Said here instead, every time focus returns, so it never depends on the
     * one moment it was said before.
     */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) showChrome(chrome)
    }

    override fun onBackPressed() {
        /* Back out of a page is always the menu — the menu is where this app
           starts and what it comes home to, whether or not the chrome happens
           to be showing. Leaving is a further step back, from there. */
        toMenu()
    }

    /**
     * Held down on a word: the recitation, standing at that word.
     *
     * Not a menu about the word. A sheet with two buttons on it was a question
     * asked in the middle of reading — this ayah or this word — and the answer
     * was nearly always the same one. So the word is lit, the player comes up
     * with the recitation already standing where that word begins, and the
     * listener presses play when they want it. One press fewer, and nothing on
     * screen that has to be dismissed before reading can go on.
     */
    private fun offer(view: MushafPageView, x: Float, y: Float) {
        val word = view.wordUnder(x, y) ?: return
        val surah = word[0]
        val ayah = word[1]
        if (surah <= 0 || ayah <= 0) return

        val voice = Recite.chosen(this)?.id ?: return
        val timing = Timing.of(this, surah, voice)
        if (timing == null) {
            AlertDialog.Builder(this).setMessage(R.string.no_timing).show()
            return
        }

        /* Lit as soon as it is held: that is the whole of the answer to "which
           word did I press". */
        lit(surah, ayah, word[2])

        /* From this word, not from the top of its ayah — the word held is the
           word meant. Its ayah's beginning where the timings cannot place the
           word itself. */
        val from = timing.wordSpan(ayah, word[2])?.get(0) ?: timing.startOf(ayah)

        until = 0
        litAyah = ayah
        litWord = word[2]

        /* Already loaded, and standing on the same recording: moving is a seek
           rather than a whole new player, which is the difference between
           landing on the word at once and waiting a second for it. */
        if (Recite.playing == surah && reading != null) {
            startedAt = from
            Recite.seek(from)
            showChrome(true)
            follow()
            sayPlayer()
            return
        }

        begin(surah, from, andPlay = false)
    }

    /** Put the recitation on, and the player with it. */
    private fun begin(surah: Int, from: Int, andPlay: Boolean = true) {
        /* Nothing can be lit until every word knows which ayah it belongs to.
           That counting starts when the app does, on a thread nothing waits
           for, and is long finished by the time anyone asks to be read to — but
           if it is not, it is waited for here rather than lighting the wrong
           words or none. */
        if (!Ayat.ready) Ayat.build(this)

        startedAt = from
        readingSurah = surah
        reading = Recite.chosen(this)?.id?.let { Timing.of(this, surah, it) }
        Recite.start(this, surah, from, andPlay)
        /* Starting a recitation brings the chrome in with it, which is what
           puts the player on screen: it is part of the chrome and comes and
           goes with the rest of it. */
        showChrome(true)
        follow()
        sayPlayer()
    }

    private fun sayPlayer() {
        findViewById<ImageView>(R.id.p_play)
            .setImageResource(if (Recite.wantsToPlay()) R.drawable.ic_pause else R.drawable.ic_play)

        val name = Surahs.list().firstOrNull { it.id == readingSurah }?.name.orEmpty()
        val said = getString(R.string.surah_named, name)
        findViewById<TextView>(R.id.p_where).text =
            if (litAyah > 0) said + "  \u00b7  " + getString(R.string.ayah_of, figures(litAyah))
            else said
    }

    /** Play and pause, who is reading, what to repeat, and the way out. */
    private fun wirePlayer() {
        findViewById<View>(R.id.p_play).setOnClickListener {
            if (Recite.playing == 0) {
                /* Nothing loaded: begin the surah again rather than doing
                   nothing at all. */
                if (readingSurah > 0) begin(readingSurah, 0)
                return@setOnClickListener
            }
            Recite.toggle()
            if (Recite.wantsToPlay()) follow() else player.removeCallbacks(follower)
            sayPlayer()
        }

        /* Jump to the page the recitation is on right now. The reader may have
           swiped away; this brings the page back without interrupting the audio. */
        findViewById<View>(R.id.p_locate).setOnClickListener {
            val on = Ayat.pageOf(readingSurah, litAyah)
            if (on in 1..pages) go(on)
        }

        findViewById<View>(R.id.p_reciter).setOnClickListener {
            if (readingSurah <= 0) return@setOnClickListener
            val voices = Recite.reciters()
            val labels = voices.map { r ->
                if (r.noteAr.isEmpty()) r.nameAr else r.nameAr + "\n" + r.noteAr
            }.toTypedArray()
            val now = voices.indexOfFirst { it.id == Recite.chosen(this)?.id }

            AlertDialog.Builder(this)
                .setTitle(R.string.reciter)
                .setSingleChoiceItems(labels, now) { dialog, i ->
                    dialog.dismiss()
                    val id = voices[i].id
                    if (id == Recite.chosen(this)?.id) return@setSingleChoiceItems

                    /* What to keep across the change: the ayah and word being
                       said, and whether it was running. Not the moment — two
                       reciters are never at the same moment, and the old one's
                       milliseconds mean nothing in the new one's recording. */
                    val keepAyah = litAyah
                    val keepWord = litWord
                    val wasPlaying = Recite.wantsToPlay()
                    val wasWordOnly = until > 0

                    Recite.choose(this, id)
                    val fresh = Timing.of(this, readingSurah, id)

                    val span = if (keepWord >= 0 && keepAyah > 0) {
                        fresh?.wordSpan(keepAyah, keepWord)
                    } else {
                        null
                    }
                    /* A word-only listen keeps being a word-only listen; a full
                       surah listen keeps playing past the current word. Without
                       the check, until was set non-zero on every reciter change
                       and the follower stopped the player at the word boundary
                       immediately, making the new reciter appear to do nothing. */
                    until = if (wasWordOnly) span?.get(1) ?: 0 else 0
                    val from = span?.get(0)
                        ?: if (keepAyah > 0) fresh?.startOf(keepAyah) ?: 0 else 0

                    begin(readingSurah, from, wasPlaying)
                }
                .show()
        }

        findViewById<View>(R.id.p_repeat).setOnClickListener {
            val labels = arrayOf(
                getString(R.string.repeat_off),
                getString(R.string.repeat_ayah),
                getString(R.string.repeat_surah)
            )
            AlertDialog.Builder(this)
                .setTitle(R.string.repeat)
                .setSingleChoiceItems(labels, Recite.repeat) { dialog, which ->
                    Recite.repeat = which
                    dialog.dismiss()
                }
                .show()
        }

        findViewById<View>(R.id.p_close).setOnClickListener {
            Recite.stop()
            stopFollowing()
            player.visibility = View.GONE
        }

        /* Lifted clear of the phone's own buttons, which are showing whenever
           this is. Measured, like the strip at the top, so that it is a
           constant and not something that moves as the bars come and go. */
        (player.layoutParams as android.widget.FrameLayout.LayoutParams).bottomMargin =
            footBand() + (12 * resources.displayMetrics.density).toInt()

        /* Keep the pager's bottom padding equal to the player bar's full height
           (bar + its bottom margin) so that every word on the last line of the
           page is reachable by scrolling — the player bar never buries text the
           reader wants to touch. clipToPadding="false" on the pager lets pages
           draw into the padding area; they are just not the final resting place
           of a snap-settled page. The listener fires whenever the player changes
           geometry — shown, hidden, or reflowed — so no manual update is needed. */
        player.addOnLayoutChangeListener { v, _, top, _, bottom, _, _, _, _ ->
            val h = bottom - top
            val lp = v.layoutParams as android.widget.FrameLayout.LayoutParams
            val pad = if (v.visibility == View.VISIBLE && h > 0) h + lp.bottomMargin else 0
            if (pager.paddingBottom != pad) {
                pager.setPadding(pager.paddingLeft, pager.paddingTop,
                    pager.paddingRight, pad)
            }
        }
    }

    /**
     * Follow the recitation, word by word.
     *
     * Twenty times a second, which is often enough that a word lights as it is
     * said and seldom enough to cost nothing. Everything it needs was settled
     * before a sound was played: the timings ship with the app, and which word
     * is which on a page was counted once for the whole mushaf.
     */
    private val follower = object : Runnable {
        override fun run() {
            if (Recite.playing == 0) {
                /* The recitation is over — it ran to the end of the surah, or
                   failed to load. The bar goes with it: left up, it was a play
                   button with nothing behind it, which did nothing when pressed
                   and said nothing about why. */
                stopFollowing()
                player.visibility = View.GONE
                readingSurah = 0
                reading = null
                return
            }
            /* The recitation has moved to another surah — it ran off the end
               of this one and carried on. What is being followed has to move
               with it: other timings, another page, and the ayah count starts
               again. */
            if (Recite.playing != readingSurah) {
                readingSurah = Recite.playing
                reading = Recite.chosen(this@ReaderActivity)?.id
                    ?.let { Timing.of(this@ReaderActivity, readingSurah, it) }
                litAyah = 0
                litWord = -1
                until = 0
                startedAt = 0
                sayPlayer()
            }

            val timing = reading
            if (timing != null) {
                val at = Recite.at()

                /* A single word, said and finished. */
                if (until > 0 && at >= until) {
                    if (Recite.repeat == Recite.ONCE) {
                        Recite.toggle()
                        sayPlayer()
                        /* A word ends where the next one begins, so by this
                           moment the light has already stepped on. It is put
                           back: what was asked for was this word, and this word
                           is what should be left lit. */
                        lit(readingSurah, litAyah, litWord)
                        return
                    }
                    Recite.seek(startedAt)
                }

                /* An ayah set to repeat is sent back to its own beginning
                   rather than being allowed to run on into the next. */
                if (Recite.repeat == Recite.AYAH && litAyah > 0 && at > timing.endOf(litAyah)) {
                    Recite.seek(timing.startOf(litAyah))
                } else {
                    /* Told what it said last time: the answer is nearly
                       always that or the next one. */
                    val ayah = timing.ayahAt(at, litAyah)
                    if (ayah > 0) {
                        if (ayah != litAyah) {
                            litAyah = ayah
                            sayPlayer()
                            /* The page follows the voice: an ayah that begins
                               on another page turns to it. */
                            val on = Ayat.pageOf(readingSurah, ayah)
                            if (on in 1..pages && on != page()) go(on)
                        }
                        val w = timing.wordAt(ayah, at)
                        litWord = w
                        lit(readingSurah, ayah, w)
                    }
                }
            }
            /* Twenty times a second while it is running; a quarter of that
               while it is paused, where there is nothing to follow but the
               buttons still want to be right. */
            player.postDelayed(this, if (Recite.isPlaying()) 50 else 250)
        }
    }

    private fun follow() {
        player.removeCallbacks(follower)
        player.post(follower)
    }

    private fun stopFollowing() {
        player.removeCallbacks(follower)
        litAyah = 0
        litWord = -1
        until = 0
        lit(-1, -1, -1)
        sayPlayer()
    }

    /** Tell whichever pages are on screen which word is being said. */
    private fun lit(surah: Int, ayah: Int, word: Int) {
        for (i in 0 until pager.childCount) {
            (pager.getChildAt(i) as? MushafPageView)?.light(surah, ayah, word)
        }
    }

    /** A page each, drawn by MushafPageView. */
    private inner class Pages : RecyclerView.Adapter<Holder>() {

        override fun getItemCount() = pages

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
            val v = MushafPageView(parent.context)
            v.layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            /* A tap anywhere on the page asks for the chrome, or puts it away.
               A long press asks to be read to, and asks it of one word: the
               page knows which word a finger landed on, so the offer can be
               about that word rather than about the page in general. */
            v.setOnClickListener { showChrome(!chrome) }
            v.setOnLongClickListener { view ->
                offer(view as MushafPageView, lastTouchX, lastTouchY)
                true
            }
            v.setOnTouchListener { _, e ->
                lastTouchX = e.x
                lastTouchY = e.y
                false
            }
            return Holder(v)
        }

        override fun onBindViewHolder(holder: Holder, position: Int) {
            (holder.itemView as MushafPageView).show(position + 1)
        }
    }

    class Holder(v: View) : RecyclerView.ViewHolder(v)
}
