package com.readqurantoday.quran

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.os.Build
import android.util.AttributeSet
import android.view.View

/**
 * One page of the mushaf, drawn.
 *
 * The page is a fixed grid: fifteen lines, whatever is on them, so that every
 * page of the book falls at the same place on the screen as it does on paper.
 * The type is sized to the width — a line of this edition is 15.98 ems across,
 * which is what mushaf.json means by its "fit" — and the lines are then spread
 * down the height they have been given.
 *
 * Nothing here draws text. It draws glyphs, by number, at positions worked out
 * from the advances in the font itself.
 *
 * That distinction is the whole of this file. Drawing text means handing a
 * string to the system and taking back whatever the apparatus behind it
 * decides: the character map, the Arabic shaper with its joining and ligature
 * rules, bidi reordering, and a fallback font for anything the face has not
 * got. All of that exists to turn ordinary writing into glyphs. This edition
 * arrives with that work already done — one finished word per codepoint, cut
 * for one page — so every one of those steps is a chance to be handed back
 * something other than what the page says. The codepoints are U+FC41 upward,
 * Arabic presentation forms rather than the private-use characters they were
 * taken for, so the system reads a script in them and brings a script's rules
 * to bear.
 *
 * Given glyph numbers it has nothing to decide: no map to consult, no script to
 * infer, no font to fall back to, and the order is the order they are written
 * in.
 */
class MushafPageView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        isSubpixelText = true

        /* No hinting.
         *
         * Every glyph in these faces carries three to five hundred bytes of
         * TrueType instructions, and the rasteriser will run them: at a body
         * size they pull the outlines about hard enough to close a counter or
         * fill a bowl, which is what the black wedges in the words were. A
         * browser never showed them because browsers do not hint a webfont.
         * The glyphs are drawn as they were cut, and scaled, and that is all
         * that is wanted from a face that holds one page of finished words.
         */
        hinting = Paint.HINTING_OFF
        isLinearText = true
    }

    /* The running head and the folio: the small type that labels the page
       rather than being it. Its own paint, in the phone's own font — these are
       words about the page, not words of it. */
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
    }

    /* The names face is drawn, not written, so it wants the same treatment the
       page does: no hinting, and placement by its own advances. */
    /* The number closing an ayah, in the same blue as the juz, surah and folio
       labels around the page — so the marks that punctuate the text and the
       marks that label the page read as one hand. */
    private val markPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        isSubpixelText = true
        hinting = Paint.HINTING_OFF
        isLinearText = true
    }

    private val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        isSubpixelText = true
        hinting = Paint.HINTING_OFF
        isLinearText = true
    }

    private var lines: List<Mushaf.Line> = emptyList()
    private var table: Mushaf.Glyphs? = null
    private var font: android.graphics.fonts.Font? = null
    private var pageNo = 0

    /* The gap a closing line opens between its words, in ems of its own size —
       the same 0.32 the stylesheet uses, so a short line reads alike in both
       readers. A full line needs no such number: what it opens is whatever the
       measure has left over. */
    private val centreGap = 0.32f

    /* A couple of hundred words are drawn as two glyphs with a gap between
       them, which the source writes as a space. This face has no space glyph at
       all, so the gap is drawn rather than typed: 0.04em, a hair space, which
       is the width the older edition of this mushaf designs it at and what
       mushaf.js gives it on the web. It was 0.22em here, five times too wide,
       borrowed from nothing. */
    private val innerSpace = 0.04f

    private var padX = 0f
    private var padTop = 0f
    private var padBottom = 0f

    /* What the head and the folio take off the top and bottom of the sheet.
       The type is set in what is left, so the page keeps its fifteen lines
       whole and the labels never crowd them. */
    private var headBand = 0f
    private var footBand = 0f

    /* Reused rather than allocated per line: onDraw runs on the frame that
       binds an incoming page, which is the one frame of a page turn with any
       work in it at all. */
    private var ids = IntArray(320)
    private var spots = FloatArray(640)

    /* The ayah marks are kept apart as the line is walked, because they are
       drawn in another colour and a run can only carry one. */
    private var markIds = IntArray(64)
    private var markSpots = FloatArray(128)

    /* The wash behind the word being recited. */
    private val glow = Paint(Paint.ANTI_ALIAS_FLAG)

    /* Where every word of this page ended up, so a finger can be told what it
       landed on: left, right, top, bottom, and the surah, ayah and word it is.
       Rebuilt on each draw, which is the only time the answer is known. */
    private val placed = ArrayList<FloatArray>(200)

    /* The word being recited, if any. */
    private var litSurah = -1
    private var litAyah = -1
    private var litWord = -1

    /* The count as the page is walked: which surah, which ayah, which word. */
    private var atSurah = 0
    private var atAyah = 0
    private var atWord = 0

    init {
        val d = resources.displayMetrics.density
        padX = 14f * d
        padTop = 8f * d
        padBottom = 8f * d
        headBand = 26f * d
        footBand = 22f * d
        label.textSize = 12f * resources.displayMetrics.scaledDensity
    }

    /**
     * Take the colours as they are now.
     *
     * Read here, on every page bound, rather than handed in once when the view
     * was made. A page view is made once and then used again for page after
     * page, so colours pushed into it at birth were the colours of whichever
     * theme happened to be on at the time — and they stayed. Turning the app to
     * light left the paper light and the ink still set for the dark: a page
     * written in the wrong hand for the ground it was on.
     */
    private fun dress() {
        setBackgroundColor(context.getColor(R.color.paper))
        paint.color = context.getColor(R.color.ink)

        val labelling = context.getColor(R.color.accent)
        label.color = labelling
        markPaint.color = labelling

        titlePaint.color = context.getColor(R.color.ornament)
        glow.color = context.getColor(R.color.accent_soft)
    }

    /**
     * Light this word, or none of them.
     *
     * Named rather than numbered — surah, ayah, word — because that is what the
     * recitation knows. Which glyph on which page it turns out to be is this
     * view's business and nobody else's.
     */
    fun light(surah: Int, ayah: Int, word: Int) {
        if (surah == litSurah && ayah == litAyah && word == litWord) return
        litSurah = surah
        litAyah = ayah
        litWord = word
        invalidate()
    }

    /** What is under this point, as surah, ayah and word — or null. */
    fun wordUnder(x: Float, y: Float): IntArray? {
        for (w in placed) {
            if (x >= w[0] && x <= w[1] && y >= w[2] && y <= w[3]) {
                return intArrayOf(w[4].toInt(), w[5].toInt(), w[6].toInt())
            }
        }
        return null
    }

    fun show(page: Int) {
        dress()
        pageNo = page
        lines = Mushaf.lines(page)
        table = Mushaf.glyphs(context, page)
        font = Mushaf.font(context, page)
        paint.typeface = Mushaf.face(context, page)
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val glyphs = table ?: return
        if (lines.isEmpty()) return

        val left = padX
        val right = width - padX
        val measure = right - left
        if (measure <= 0) return

        /* The type size the page is set at: the width divided by how many ems a
           full line takes. Every line starts here and only shrinks from it. */
        val body = (measure / Mushaf.emWidth).toFloat()

        /* Fifteen lines, always — a page with eight of them is a framed opening
           and keeps the same grid, so the words sit where they do on paper. */
        val grid = 15
        val top = padTop + headBand
        val step = (height - top - padBottom - footBand) / grid

        runningHead(canvas, left, measure)
        folio(canvas)

        /* Where the numbering stands as this page opens, worked out once for
           the whole mushaf and looked up here. */
        atSurah = Ayat.surahAt(pageNo)
        atAyah = Ayat.ayahAt(pageNo)
        atWord = Ayat.wordAt(pageNo)
        placed.clear()

        /* Down the middle of each line's slot, which is what puts the baseline
           in the same place whatever is drawn on it. */
        paint.textSize = body
        val centreOffset = -(paint.ascent() + paint.descent()) / 2f

        var slot = 0
        for (line in lines) {
            if (slot >= grid) break
            val y = top + step * slot + step / 2f + centreOffset
            slot++
            /* A page is not only its verses. Where a surah begins the mushaf
               prints its name across the line, and under it the Basmalah — both
               of them lines with no words of their own, which is why they were
               being passed over and the openings came out blank. */
            when (line.kind) {
                /* A surah beginning partway down a page starts its own count,
                   and every word after it on this page belongs to it. */
                "surah" -> if (line.surah > 0) {
                    atSurah = line.surah
                    atAyah = 1
                    atWord = 0
                    title(canvas, line.surah, left + measure / 2f, step * 0.95f, y)
                }
                "basmalah" -> basmalah(canvas, left + measure / 2f, body * 0.86f, y)
                else -> if (line.words.isNotEmpty()) {
                    drawLine(canvas, line, glyphs, left, measure, body, y, step)
                }
            }
        }
    }

    /**
     * One line, fitted to the measure and laid out right to left.
     *
     * A line of this edition is cut to fill the measure very nearly exactly.
     * What it falls short by is shared out between the words — what the
     * stylesheet says with justify-content: space-between — and what it runs
     * over by is taken out of the type size instead. A line well short of the
     * measure is a closing line, and is centred on a fixed gap rather than
     * prised apart to fill a width it was never meant to fill.
     */
    private fun drawLine(
        canvas: Canvas,
        line: Mushaf.Line,
        glyphs: Mushaf.Glyphs,
        left: Float,
        measure: Float,
        body: Float,
        y: Float,
        slot: Float
    ) {
        /* A word's parts are joined back up with the space that parted them; it
           becomes a gap below, the face having no glyph for it. */
        val words = line.words.map { it.joinToString(" ") }

        var size = body
        var natural = lineWidth(words, glyphs, size)
        if (natural <= 0f) return

        /* Over the measure: set a shade smaller, and a hair under it, so that
           rounding cannot put the line back over the edge — the same 99.5% the
           web reader uses. */
        if (natural > measure) {
            size = body * (measure / natural) * 0.995f
            natural = lineWidth(words, glyphs, size)
        }

        val gaps = words.size - 1
        val spare = (measure - natural).coerceAtLeast(0f)
        val short = natural < measure * Mushaf.centreBelow
        val gap = when {
            gaps <= 0 -> 0f
            short -> minOf(centreGap * size, spare / gaps)
            else -> spare / gaps
        }

        paint.textSize = size

        /* From the right margin, or from where a centred line begins. */
        val start = if (short) left + (measure + natural + gap * gaps) / 2f else left + measure

        val scale = size / glyphs.upem
        val marks = Mushaf.marksOn(pageNo)
        var x = start
        var n = 0
        var m = 0

        for (word in words) {
            /* A word that is one of this page's marks is the number that closes
               an ayah, not a word of it. */
            val isMark = word.isNotEmpty() && marks.contains(word)

            /* What this word is, before the count moves past it. The closing
               number belongs to its ayah but is never the word being said, so
               it is given no number of its own. */
            val ofSurah = atSurah
            val ofAyah = atAyah
            val ofWord = if (isMark) -1 else atWord

            val began = x
            var pen = x
            var i = 0
            while (i < word.length) {
                val cp = word.codePointAt(i)
                i += Character.charCount(cp)

                val id = glyphs.id(cp)
                if (id < 0) {
                    /* Not in the face: the space inside a word, and nothing
                       else. A gap, not a glyph. */
                    pen -= innerSpace * size
                    continue
                }

                val advance = glyphs.advance(cp) * scale
                if (isMark) {
                    if (m * 2 + 1 >= markSpots.size) growMarks()
                    markIds[m] = id
                    markSpots[m * 2] = pen - advance
                    markSpots[m * 2 + 1] = y
                    m++
                    pen -= advance
                    continue
                }
                if (n * 2 + 1 >= spots.size) grow()
                ids[n] = id
                /* Placed by the left edge of its advance, which is where the
                   glyph's own origin sits — never by its ink. These faces
                   overhang hard by design, tails running the better part of an
                   em back under the word beside them, and it is the advances
                   that make them interlock as they were cut to. */
                spots[n * 2] = pen - advance
                spots[n * 2 + 1] = y
                n++
                pen -= advance
            }
            /* Everything the page can say about where this word is. The
               vertical span is the line's own slot, less a little, so a lit
               word is a band around the word and not around the whole line. */
            if (!isMark) {
                placed.add(
                    floatArrayOf(
                        pen, began, y - slot * 0.44f, y + slot * 0.24f,
                        ofSurah.toFloat(), ofAyah.toFloat(), ofWord.toFloat()
                    )
                )
                if (ofSurah == litSurah && ofAyah == litAyah && ofWord == litWord) {
                    /* Drawn now, inside the walk, so that it lands under the
                       glyphs — which are all put down together at the end. */
                    val pad = slot * 0.06f
                    canvas.drawRoundRect(
                        pen - pad, y - slot * 0.44f, began + pad, y + slot * 0.24f,
                        slot * 0.18f, slot * 0.18f, glow
                    )
                }
                atWord++
            } else {
                atAyah++
                atWord = 0
            }

            x = pen - gap
        }
        if (n == 0 && m == 0) return

        val face = font
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && face != null) {
            if (n > 0) canvas.drawGlyphs(ids, 0, spots, 0, n, face, paint)
            if (m > 0) {
                markPaint.textSize = size
                canvas.drawGlyphs(markIds, 0, markSpots, 0, m, face, markPaint)
            }
        } else {
            /* Before Android 12 there is no drawing a glyph by number, so these
               phones get the words as text: placed by the font's own advances
               still, but with the system back in the way. Nothing here can help
               that. */
            markPaint.textSize = size
            markPaint.typeface = paint.typeface
            markPaint.textAlign = Paint.Align.LEFT
            var wx = start
            for (word in words) {
                val pen = if (word.isNotEmpty() && marks.contains(word)) markPaint else paint
                /* Part by part, never the whole word: a word written with a
                   space in it would otherwise have that space drawn by whatever
                   font the system finds for it, at a width neither the page nor
                   this reader chose. Split here, the face draws every part and
                   the gap between them is the hair space above. */
                for (part in word.split(' ')) {
                    if (part.isEmpty()) continue
                    val w = wordWidth(part, glyphs, size)
                    canvas.drawText(part, wx - w, y, pen)
                    wx -= w + innerSpace * size
                }
                wx += innerSpace * size
                wx -= gap
            }
        }
    }

    /**
     * The running head a printed mushaf carries: the juz on the reading side,
     * the surah in the middle, the folio on the other.
     *
     * The reading side is the right, this being a book that opens that way, so
     * the juz sits there and the page number opposite it — the same three
     * labels in the same three places as the web reader's page-head.
     */
    private fun runningHead(canvas: Canvas, left: Float, measure: Float) {
        if (pageNo <= 0) return
        val y = padTop + headBand * 0.62f

        val juz = Surahs.juzOfPage(pageNo)
        if (juz > 0) {
            label.textAlign = Paint.Align.RIGHT
            canvas.drawText(context.getString(R.string.head_juz, figures(juz)), left + measure, y, label)
        }

        Surahs.ofPage(pageNo)?.let {
            title(canvas, it.id, left + measure / 2f, headBand * 0.82f, y)
        }

        label.textAlign = Paint.Align.LEFT
        canvas.drawText(context.getString(R.string.head_page, figures(pageNo)), left, y, label)
    }

    /**
     * The surah's name in the mushaf's own hand: the word سورة and then the
     * name, both single glyphs out of the names face.
     *
     * Not the name as letters. The printed head is drawn, not typed, and the
     * face carries all 114 of them cut to match the page — so the reader sets
     * the same picture of a word the web reader does, rather than an
     * approximation of it in whatever font the phone happens to have.
     */
    private fun title(canvas: Canvas, surah: Int, centre: Float, size: Float, y: Float) {
        val names = Mushaf.names(context) ?: return
        val scale = size / names.upem

        val word = Mushaf.SURAH_WORD
        val name = Mushaf.nameCode(surah)
        /* The gap the stylesheet sets between the two — margin-inline-start on
           .ph-surah .sn — so the pair reads as it does on the web. */
        val between = 0.1f * size

        val wordW = names.advance(word) * scale
        val nameW = names.advance(name) * scale
        val total = wordW + between + nameW
        if (total <= 0f) return

        titlePaint.textSize = size

        /* Right to left: the word first, at the right of the pair. */
        var pen = centre + total / 2f
        for (cp in intArrayOf(word, name)) {
            val advance = names.advance(cp) * scale
            glyph(canvas, names, cp, pen - advance, y)
            pen -= advance + between
        }
    }

    /** One glyph of the names face, by number where the phone allows it. */
    private fun glyph(canvas: Canvas, names: Mushaf.Glyphs, cp: Int, x: Float, y: Float) {
        val id = names.id(cp)
        if (id < 0) return
        val face = Mushaf.nameFace(context)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && face != null) {
            canvas.drawGlyphs(intArrayOf(id), 0, floatArrayOf(x, y), 0, 1, face, titlePaint)
        } else {
            titlePaint.typeface = Mushaf.nameTypeface(context)
            titlePaint.textAlign = Paint.Align.LEFT
            canvas.drawText(String(Character.toChars(cp)), x, y, titlePaint)
        }
    }

    /**
     * The Basmalah, on the line the mushaf gives it under a surah's name.
     *
     * Its four words are quoted from page 1 and drawn in page 1's face — the
     * opening of Al-Fatihah is the Basmalah, so the glyphs are already cut
     * there — which is why this reaches for another page's table rather than
     * the one being drawn. Centred, at the size the stylesheet sets it, and in
     * the labelling colour as the web reader has it.
     */
    private fun basmalah(canvas: Canvas, centre: Float, size: Float, y: Float) {
        val words = Mushaf.basmalah
        if (words.isEmpty()) return
        val from = Mushaf.basmalahPage
        val glyphs = Mushaf.glyphs(context, from) ?: return

        val scale = size / glyphs.upem
        var total = 0f
        for (word in words) total += wordWidth(word, glyphs, size)
        if (total <= 0f) return

        titlePaint.textSize = size

        var pen = centre + total / 2f
        var n = 0
        for (word in words) {
            var i = 0
            while (i < word.length) {
                val cp = word.codePointAt(i)
                i += Character.charCount(cp)
                val id = glyphs.id(cp)
                if (id < 0) {
                    pen -= innerSpace * size
                    continue
                }
                val advance = glyphs.advance(cp) * scale
                if (n * 2 + 1 >= spots.size) grow()
                ids[n] = id
                spots[n * 2] = pen - advance
                spots[n * 2 + 1] = y
                n++
                pen -= advance
            }
        }
        if (n == 0) return

        val face = Mushaf.font(context, from)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && face != null) {
            canvas.drawGlyphs(ids, 0, spots, 0, n, face, titlePaint)
        } else {
            titlePaint.typeface = Mushaf.face(context, from)
            titlePaint.textAlign = Paint.Align.LEFT
            var wx = centre + total / 2f
            for (word in words) {
                val w = wordWidth(word, glyphs, size)
                canvas.drawText(word, wx - w, y, titlePaint)
                wx -= w
            }
        }
    }

    /** The folio, centred under the text, as it is printed. */
    private fun folio(canvas: Canvas) {
        if (pageNo <= 0) return
        label.textAlign = Paint.Align.CENTER
        canvas.drawText(figures(pageNo), width / 2f, height - padBottom - footBand * 0.3f, label)
    }

    /**
     * The number as the page writes it: ٧ in Arabic, 7 in English.
     *
     * The web reader turns its figures with its language and this follows it —
     * a running head that says "Page ٧" is neither one thing nor the other.
     */
    private fun figures(n: Int): String {
        if (resources.configuration.locales[0].language != "ar") return n.toString()
        val out = StringBuilder()
        for (c in n.toString()) out.append(('٠' + (c - '0')))
        return out.toString()
    }

    /** What the words come to at this size, before anything is opened up. */
    private fun lineWidth(words: List<String>, glyphs: Mushaf.Glyphs, size: Float): Float {
        var sum = 0f
        for (word in words) sum += wordWidth(word, glyphs, size)
        return sum
    }

    private fun wordWidth(word: String, glyphs: Mushaf.Glyphs, size: Float): Float {
        val scale = size / glyphs.upem
        var sum = 0f
        var i = 0
        while (i < word.length) {
            val cp = word.codePointAt(i)
            i += Character.charCount(cp)
            sum += if (glyphs.id(cp) < 0) innerSpace * size else glyphs.advance(cp) * scale
        }
        return sum
    }

    private fun grow() {
        ids = ids.copyOf(ids.size * 2)
        spots = spots.copyOf(spots.size * 2)
    }

    private fun growMarks() {
        markIds = markIds.copyOf(markIds.size * 2)
        markSpots = markSpots.copyOf(markSpots.size * 2)
    }
}
