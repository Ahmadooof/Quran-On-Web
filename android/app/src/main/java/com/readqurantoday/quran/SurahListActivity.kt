package com.readqurantoday.quran

import android.app.Activity
import android.content.Intent
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

/**
 * The index: three tabs, and under the first of them the 114 surahs.
 *
 * Laid out as the web reader's drawer is, and in the same order — the surahs,
 * then listening and downloading, then the settings — so that the two readers
 * are one design. Only the first has anything in it here; the other two say so
 * rather than opening on an empty pane.
 *
 * It answers with a page and does nothing itself, so the reader stays the only
 * thing that decides what is on screen.
 */
class SurahListActivity : AppCompatActivity() {

    private lateinit var panes: List<Pair<View, View>>

    /* Which tab is open. Changing the theme rebuilds this screen — that is how
       Android puts new colours on — so the tab has to be carried across the
       rebuild, or the settings you were in the middle of changing vanish and
       you are back at the surahs. */
    private var tab = 0

    private var listenList: Listen? = null
    private var watching = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Surahs.load(this)
        Recite.load(this)
        setContentView(R.layout.activity_index)

        /* Four things in the strip, three of them tabs. The ribbon at the end
           is the fourth, and it opens the pages that have been kept — which is
           where a reader looks for the one they were on. */
        panes = listOf(
            findViewById<View>(R.id.tab_index) to findViewById(R.id.pane_index),
            findViewById<View>(R.id.tab_listen) to findViewById(R.id.pane_listen),
            findViewById<View>(R.id.tab_settings) to findViewById(R.id.pane_settings),
            findViewById<View>(R.id.resume) to findViewById(R.id.pane_marks)
        )
        panes.forEachIndexed { i, (button, _) -> button.setOnClickListener { choose(i) } }
        choose(savedInstanceState?.getInt(TAB) ?: 0)

        val list = findViewById<RecyclerView>(R.id.list)
        list.layoutManager = LinearLayoutManager(this)
        list.adapter = Adapter(Surahs.list(), Mushaf.nameTypeface(this)) { answer(it.from) }

        listen()
        wirePlayer()
        settings()
        marks()

    }

    /** Show one pane and mark its tab; the other two step back. */
    private fun choose(which: Int) {
        tab = which
        panes.forEachIndexed { i, (button, pane) ->
            val on = i == which
            pane.visibility = if (on) View.VISIBLE else View.GONE
            button.setBackgroundResource(if (on) R.drawable.tab_on else R.drawable.tab_off)
            if (button is TextView) {
                /* On the filled pill the type is knocked out white; off it, the
                   muted grey everything unchosen wears. */
                button.setTextColor(getColor(if (on) R.color.on_dark else R.color.text_mute))
            } else if (button is ImageView) {
                button.imageTintList = android.content.res.ColorStateList.valueOf(
                    getColor(if (on) R.color.on_dark else R.color.text_mute)
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        /* The activity may have been in the background while Recite's state
           changed (user paused from the notification, or the surah ended).
           Re-register the callback and repaint the player bar. */
        Recite.onChange = { runOnUiThread { player() } }
        player()
    }

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        out.putInt(TAB, tab)
    }

    /**
     * The listening pane: who is reading, and the surah to hear.
     *
     * The recordings are streamed. They are not in the package and could not
     * be — each recitation runs to twenty or thirty hours — so this wants a
     * connection, unlike the reading, which wants nothing.
     */
    private fun listen() {
        val row = layoutInflater.inflate(R.layout.row_setting, findViewById(R.id.row_reciter), false)
        row.findViewById<TextView>(R.id.set_label).setText(R.string.reciter)
        val who = row.findViewById<TextView>(R.id.set_value)

        fun sayReciter() {
            who.text = Recite.chosen(this)?.let { r ->
                if (r.noteAr.isEmpty()) r.nameAr else r.nameAr + " · " + r.noteAr
            }.orEmpty()
        }
        sayReciter()

        row.setOnClickListener {
            val voices = Recite.reciters()
            /* Both lines: two of these are the same reciter twice, and the note
               is the only thing that tells the recordings apart. */
            val labels = voices.map { r ->
                if (r.noteAr.isEmpty()) r.nameAr else r.nameAr + "\n" + r.noteAr
            }.toTypedArray()
            AlertDialog.Builder(this)
                .setTitle(R.string.reciter)
                .setItems(labels) { _, i ->
                    Recite.choose(this, voices[i].id)
                    sayReciter()
                    /* Whatever was playing carries on in the new voice, from
                       the top: this pane listens to whole surahs and has no
                       place in one to keep. */
                    if (Recite.playing != 0) Recite.start(this, Recite.playing)
                    /* And the list itself changes meaning — what is kept on the
                       phone is kept per voice. */
                    listenList?.notifyDataSetChanged()
                    player()
                }
                .show()
        }
        findViewById<LinearLayout>(R.id.row_reciter).addView(row)

        val list = findViewById<RecyclerView>(R.id.listen_list)
        list.layoutManager = LinearLayoutManager(this)
        val heard = Listen(Surahs.list(), Mushaf.nameTypeface(this),
            play = { s -> Recite.start(this, s.id); player() },
            keep = { s -> keep(s.id) },
            state = { s -> state(s.id) })
        list.adapter = heard
        listenList = heard

        Recite.onChange = { runOnUiThread { player() } }
        player()
    }

    /**
     * Fetch this surah, or give the space back if it is already here.
     *
     * The same button both ways round, because it is the same question — is
     * this kept? — and a phone has no room for two.
     */
    private fun keep(surah: Int) {
        val voice = Recite.chosen(this)?.id ?: return
        if (Downloads.has(this, surah, voice)) {
            Downloads.remove(this, surah, voice)
            listenList?.notifyDataSetChanged()
            return
        }
        Downloads.start(this, surah, voice)
        watch()
    }

    /** What the button should show for this surah, in this voice. */
    private fun state(surah: Int): Int {
        val voice = Recite.chosen(this)?.id ?: return Listen.AWAY
        return when {
            Downloads.has(this, surah, voice) -> Listen.KEPT
            Downloads.fetching(this, surah, voice) -> Listen.COMING
            else -> Listen.AWAY
        }
    }

    /* DownloadManager reports no progress to us, so while anything is coming
       the list asks it how things stand every so often. It stops asking the
       moment nothing is. */
    private fun watch() {
        if (watching) return
        watching = true
        val tick = object : Runnable {
            override fun run() {
                listenList?.notifyDataSetChanged()
                if (Downloads.busy(this@SurahListActivity)) {
                    findViewById<View>(R.id.listen_list).postDelayed(this, 1500)
                } else {
                    watching = false
                }
            }
        }
        findViewById<View>(R.id.listen_list).postDelayed(tick, 1500)
    }

    /** Show or refresh the floating player bar. */
    private fun player() {
        val bar = findViewById<LinearLayout>(R.id.player)
        val surah = Recite.playing
        if (surah == 0) {
            bar.visibility = View.GONE
            return
        }
        bar.visibility = View.VISIBLE
        val name = Surahs.list().firstOrNull { it.id == surah }?.name.orEmpty()
        findViewById<TextView>(R.id.p_where).text = getString(R.string.surah_named, name)
        findViewById<ImageView>(R.id.p_play)
            .setImageResource(if (Recite.wantsToPlay()) R.drawable.ic_pause else R.drawable.ic_play)
    }

    /**
     * Wire the floating player bar — the same six buttons the reader has,
     * doing the same things they do there.
     */
    private fun wirePlayer() {
        findViewById<View>(R.id.p_play).setOnClickListener {
            Recite.toggle()
            player()
        }

        /* Locate: find the actual ayah being recited right now (same logic the
           reader uses), then return to the page it is on. */
        findViewById<View>(R.id.p_locate).setOnClickListener {
            val surah = Recite.playing
            if (surah <= 0) return@setOnClickListener
            val rid  = Recite.chosen(this)?.id ?: return@setOnClickListener
            val ayah = Timing.of(this, surah, rid)?.ayahAt(Recite.at()) ?: 1
            val page = Ayat.pageOf(surah, ayah.coerceAtLeast(1))
            if (page in 1..604) answer(page)
        }

        /* Reciter: same dialog and same position-keep logic as the reader.
           Capture current ayah before the dialog is even opened, so the
           millisecond-to-ayah lookup runs against the old voice's timing. */
        findViewById<View>(R.id.p_reciter).setOnClickListener {
            val surah = Recite.playing
            if (surah <= 0) return@setOnClickListener

            val oldId  = Recite.chosen(this)?.id
            val oldTim = if (oldId != null) Timing.of(this, surah, oldId) else null
            val curAyah = (oldTim?.ayahAt(Recite.at()) ?: 1).coerceAtLeast(1)
            val wasPlaying = Recite.wantsToPlay()

            val voices = Recite.reciters()
            val labels = voices.map { r ->
                if (r.noteAr.isEmpty()) r.nameAr else r.nameAr + "\n" + r.noteAr
            }.toTypedArray()
            val now = voices.indexOfFirst { it.id == oldId }

            AlertDialog.Builder(this)
                .setTitle(R.string.reciter)
                .setSingleChoiceItems(labels, now) { dialog, i ->
                    dialog.dismiss()
                    val id = voices[i].id
                    if (id == Recite.chosen(this)?.id) return@setSingleChoiceItems
                    Recite.choose(this, id)
                    /* Find where the same ayah starts in the new voice's timing,
                       exactly as the reader does. */
                    val from = Timing.of(this, surah, id)?.startOf(curAyah) ?: 0
                    Recite.start(this, surah, from, wasPlaying)
                    listenList?.notifyDataSetChanged()
                }
                .show()
        }

        /* Repeat: same three-state cycle as the reader. */
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

        /* Close: stop playback and hide the bar. */
        findViewById<View>(R.id.p_close).setOnClickListener {
            Recite.stop()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        /* The player outlives this screen; only the way back to it does not. */
        Recite.onChange = null
    }

    /**
     * The settings pane: the theme, the page's brightness, and the pages kept.
     *
     * Built here rather than in the layout because two of the three are lists
     * that change — the theme cycles through its three states in place, and the
     * saved pages are however many there are.
     */
    private fun settings() {
        val theme = layoutInflater.inflate(R.layout.row_setting, findViewById(R.id.row_theme), false)
        theme.findViewById<TextView>(R.id.set_label).setText(R.string.set_theme)
        val value = theme.findViewById<TextView>(R.id.set_value)

        fun sayTheme() {
            value.setText(
                when (Settings.theme(this)) {
                    Settings.LIGHT -> R.string.theme_light
                    Settings.DARK -> R.string.theme_dark
                    else -> R.string.theme_system
                }
            )
        }
        sayTheme()

        /* Tapped, it moves on to the next of the three. Following the phone is
           first because it is what most people want and never think about. */
        theme.setOnClickListener {
            /* No recreate() here: setting the night mode rebuilds the screen by
               itself, and doing it twice was what threw the pane away. */
            Settings.setTheme(this, (Settings.theme(this) + 1) % 3)
            sayTheme()
        }
        findViewById<LinearLayout>(R.id.row_theme).addView(theme)

        /* Two languages, so a tap is the whole control: there is no third state
           to pick from and no list worth opening for it. */
        val lang = layoutInflater.inflate(R.layout.row_setting, findViewById(R.id.row_theme), false)
        lang.findViewById<TextView>(R.id.set_label).setText(R.string.set_language)
        lang.findViewById<TextView>(R.id.set_value).setText(
            if (Settings.language(this) == "en") R.string.lang_en else R.string.lang_ar
        )
        lang.setOnClickListener {
            Settings.setLanguage(this, if (Settings.language(this) == "en") "ar" else "en")
        }
        findViewById<LinearLayout>(R.id.row_theme).addView(lang)

        val page = Settings.lastPage(this)
        if (page in 1..604) {
            findViewById<View>(R.id.resume).contentDescription =
                getString(R.string.resume_where, Surahs.ofPage(page)?.name.orEmpty(), page)
        }
    }

    /**
     * The pages kept, and above them the page last read.
     *
     * Last read is not a saved page and is not stored with them — it moves on
     * its own every time a page is turned — but it is what somebody opening
     * this pane is usually after, so it is offered first and said plainly.
     */
    private fun marks() {
        val kept = findViewById<LinearLayout>(R.id.marks)
        kept.removeAllViews()

        val last = Settings.lastPage(this)
        if (last in 1..604) kept.addView(pageRow(kept, last, getString(R.string.resume)))

        val pages = Settings.marks(this)
        if (pages.isEmpty()) {
            val none = layoutInflater.inflate(R.layout.row_setting, kept, false)
            none.findViewById<TextView>(R.id.set_label).setText(R.string.no_marks)
            none.isClickable = false
            kept.addView(none)
            return
        }
        for (p in pages) kept.addView(pageRow(kept, p, Surahs.ofPage(p)?.name.orEmpty()))
    }

    /** One page to go to: what it is, and what is on it. */
    private fun pageRow(into: LinearLayout, page: Int, said: String): View {
        val row = layoutInflater.inflate(R.layout.row_setting, into, false)
        row.findViewById<TextView>(R.id.set_label).text = getString(R.string.page_named, page)
        row.findViewById<TextView>(R.id.set_value).text = said
        row.setOnClickListener { answer(page) }
        return row
    }

    override fun onBackPressed() {
        /* The menu is home, so backing out of it leaves the app rather than
           dropping onto the page behind — which is the page that would send you
           straight back here. */
        finishAffinity()
    }

    /** The index answers with a page and nothing else. */
    private fun answer(page: Int) {
        setResult(Activity.RESULT_OK, Intent().putExtra(PAGE, page))
        finish()
    }

    /**
     * The listening list. Tapping the row plays the surah; the button beside it
     * keeps a copy, or throws one away.
     */
    private class Listen(
        val surahs: List<Surahs.Surah>,
        val names: Typeface?,
        val play: (Surahs.Surah) -> Unit,
        val keep: (Surahs.Surah) -> Unit,
        val state: (Surahs.Surah) -> Int
    ) : RecyclerView.Adapter<Row>() {

        companion object {
            const val AWAY = 0
            const val COMING = 1
            const val KEPT = 2
        }

        override fun getItemCount() = surahs.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            Row(
                LayoutInflater.from(parent.context).inflate(R.layout.item_listen, parent, false),
                names
            )

        override fun onBindViewHolder(holder: Row, position: Int) {
            val s = surahs[position]
            holder.fill(s)
            holder.itemView.setOnClickListener { play(s) }

            val get = holder.itemView.findViewById<ImageView>(R.id.get)
            when (state(s)) {
                KEPT -> {
                    get.setImageResource(R.drawable.ic_downloaded)
                    get.alpha = 1f
                }
                COMING -> {
                    get.setImageResource(R.drawable.ic_download)
                    get.alpha = 0.4f
                }
                else -> {
                    get.setImageResource(R.drawable.ic_download)
                    get.alpha = 1f
                }
            }
            get.setOnClickListener { keep(s) }
        }
    }

    private class Adapter(
        val surahs: List<Surahs.Surah>,
        val names: Typeface?,
        val chosen: (Surahs.Surah) -> Unit
    ) : RecyclerView.Adapter<Row>() {

        override fun getItemCount() = surahs.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            Row(
                LayoutInflater.from(parent.context).inflate(R.layout.item_surah, parent, false),
                names
            )

        override fun onBindViewHolder(holder: Row, position: Int) {
            val s = surahs[position]
            holder.fill(s)
            holder.itemView.setOnClickListener { chosen(s) }
        }
    }

    private class Row(v: View, names: Typeface?) : RecyclerView.ViewHolder(v) {
        val num: TextView = v.findViewById(R.id.num)
        val word: TextView = v.findViewById(R.id.word)
        val name: TextView = v.findViewById(R.id.name)
        val english: TextView = v.findViewById(R.id.english)
        val ayahs: TextView = v.findViewById(R.id.ayahs)

        /* The name as the mushaf draws it: the word سورة and then the name, each
           a single glyph of the names face. Written out in the phone's Arabic
           font instead, the diacritics were never right. */
        fun fill(s: Surahs.Surah) {
            num.text = s.id.toString()
            word.text = String(Character.toChars(Mushaf.SURAH_WORD))
            name.text = String(Character.toChars(Mushaf.nameCode(s.id)))
            /* Named for a screen reader, which reads nothing at all off a
               private-use glyph. */
            name.contentDescription = s.name
            english.text = s.english
            ayahs.text = s.ayahs.toString()
        }

        init {
            for (t in listOf(word, name)) {
                t.typeface = names
                /* The same treatment the page gets: these faces carry TrueType
                   instructions that fill the shapes in at a reading size. */
                t.paint.hinting = Paint.HINTING_OFF
                t.paint.isLinearText = true
            }
        }
    }

    companion object {
        const val PAGE = "page"
        private const val TAB = "tab"
    }
}
