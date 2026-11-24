// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: oyun görüntüsünün altyazı bölgesini okur (cihaz içinde, ML Kit),
// sunucudan Türkçesini alır ve oyunun üstünde gösterir.

package com.metallic.chiaki.efex

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.util.LruCache
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.widget.TextView
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

class SubtitleEngine(
	context: Context,
	/** O an görüntüyü gösteren SurfaceView (normal ya da GL) */
	private val streamView: () -> SurfaceView?,
	/** Türkçe altyazının yazıldığı kutu */
	private val subtitleView: TextView,
	/** Kısa uyarılar ("çeviri hakkı doldu") */
	private val noticeView: TextView,
	/** Okuma durumunu gösteren küçük satır (ayarlardan açılıp kapanır) */
	private val debugView: TextView?
)
{
	companion object
	{
		private const val TAG = "EfexSub"
		private const val INTERVAL_MS = 350L
		private const val MAX_BITMAP_WIDTH = 1280
		private const val SAME_TEXT_RATIO = 0.82
		private const val NOTICE_COOLDOWN_MS = 60_000L
	}

	private val appContext = context.applicationContext
	private val main = Handler(Looper.getMainLooper())
	private val copyThread = HandlerThread("EfexSubCopy").apply { start() }
	private val copyHandler = Handler(copyThread.looper)
	private val ocrExecutor = Executors.newSingleThreadExecutor()
	private val netExecutor = Executors.newSingleThreadExecutor()
	private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
	private val cache = LruCache<String, String>(800)

	/** Ayarlar paneli değiştikçe güncellenir */
	@Volatile var settings: EfexSettings = EfexSettings.load(context)
		set(value)
		{
			field = value
			if(!value.enabled)
				main.post { hideSubtitle() }
			if(!value.showStatus)
				main.post { debugView?.visibility = View.GONE }
		}

	@Volatile private var running = false
	@Volatile private var busy = false
	private var bitmap: Bitmap? = null

	// Okuma durumu (sadece ocrExecutor'da değişir)
	private var lastSeenKey: String? = null
	private var lastSeenText: String? = null
	private var stableCount = 0
	private var emptyCount = 0
	@Volatile private var currentKey: String? = null
	private var lastNoticeAt = 0L
	private var copyFailures = 0

	fun start()
	{
		if(running)
			return
		running = true
		copyHandler.post(tick)
	}

	fun stop()
	{
		running = false
		copyHandler.removeCallbacks(tick)
		main.post { hideSubtitle() }
	}

	fun release()
	{
		stop()
		copyThread.quitSafely()
		ocrExecutor.shutdown()
		netExecutor.shutdown()
		recognizer.close()
	}

	private val tick = object : Runnable
	{
		override fun run()
		{
			if(!running)
				return
			if(!busy && settings.enabled)
				capture()
			copyHandler.postDelayed(this, INTERVAL_MS)
		}
	}

	private fun capture()
	{
		val view = streamView() ?: return
		val surface = view.holder.surface
		if(surface == null || !surface.isValid || view.visibility != View.VISIBLE)
			return
		val frame = view.holder.surfaceFrame
		if(frame.width() <= 0 || frame.height() <= 0)
			return
		val st = settings
		val src = Rect(
			(frame.width() * st.regionLeft).toInt(),
			(frame.height() * st.regionTop).toInt(),
			(frame.width() * st.regionRight).toInt(),
			(frame.height() * st.regionBottom).toInt())
		if(src.width() < 16 || src.height() < 16)
			return
		val scale = min(1f, MAX_BITMAP_WIDTH.toFloat() / src.width())
		val w = max(1, (src.width() * scale).toInt())
		val h = max(1, (src.height() * scale).toInt())
		val bmp = bitmap?.takeIf { it.width == w && it.height == h }
			?: Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { bitmap = it }

		busy = true
		val started = SystemClock.elapsedRealtime()
		try
		{
			PixelCopy.request(view, src, bmp, { result ->
				if(result == PixelCopy.SUCCESS)
				{
					copyFailures = 0
					recognize(bmp, started)
				}
				else
				{
					copyFailures++
					busy = false
					if(copyFailures == 10)
						debug("Görüntü okunamıyor (PixelCopy $result)")
				}
			}, copyHandler)
		}
		catch(e: Exception)
		{
			busy = false
			Log.w(TAG, "PixelCopy failed", e)
		}
	}

	private fun recognize(bmp: Bitmap, started: Long)
	{
		val image = InputImage.fromBitmap(bmp, 0)
		recognizer.process(image)
			.addOnSuccessListener(ocrExecutor) { text ->
				try
				{
					handleText(extractSubtitle(text, bmp.width), SystemClock.elapsedRealtime() - started)
				}
				finally
				{
					busy = false
				}
			}
			.addOnFailureListener(ocrExecutor) { e ->
				busy = false
				Log.w(TAG, "OCR failed", e)
			}
	}

	/** Ortadaki satırları (altyazı) alır, kenardaki HUD yazılarını atar. */
	private fun extractSubtitle(text: Text, width: Int): String
	{
		val lines = text.textBlocks.flatMap { it.lines }.filter { line ->
			val box = line.boundingBox ?: return@filter false
			val cx = box.centerX().toFloat() / width
			cx in 0.15f..0.85f && line.text.count { it.isLetter() } >= 2
		}.sortedBy { it.boundingBox?.top ?: 0 }
		return lines.joinToString(" ") { it.text.trim() }.replace(Regex("\\s+"), " ").trim()
	}

	private fun keyOf(s: String) = s.lowercase().filter { it.isLetterOrDigit() || it == ' ' }.replace(Regex(" +"), " ").trim()

	private fun handleText(raw: String, ms: Long)
	{
		val letters = raw.count { it.isLetter() }
		if(letters < 4)
		{
			emptyCount++
			stableCount = 0
			lastSeenKey = null
			if(emptyCount >= 2 && currentKey != null)
			{
				currentKey = null
				main.post { hideSubtitle() }
			}
			debug("OCR ${ms}ms · altyazı yok")
			return
		}
		emptyCount = 0
		val key = keyOf(raw)
		val prev = lastSeenKey
		if(prev != null && similar(prev, key))
		{
			stableCount++
			// Okumalar arasından en uzun olanı (genelde en eksiksiz) tut
			if(raw.length > (lastSeenText?.length ?: 0))
				lastSeenText = raw
		}
		else
		{
			stableCount = 1
			lastSeenText = raw
		}
		lastSeenKey = key
		debug("OCR ${ms}ms · ${raw.take(80)}")

		val cur = currentKey
		if(stableCount >= 2 && (cur == null || !similar(cur, key)))
		{
			currentKey = key
			val text = lastSeenText ?: raw
			translate(key, text)
		}
	}

	private fun translate(key: String, text: String)
	{
		cache.get(key)?.let { tr ->
			main.post { if(currentKey == key && settings.enabled) showSubtitle(tr) }
			return
		}
		netExecutor.execute {
			val r = EfexClient.translate(appContext, listOf(text))
			val result = r.value
			if(result == null)
			{
				debug("Çeviri hatası: ${r.error}")
				// Kod kapatıldı/silindi ya da başka cihaza geçti: kullanıcıya söyle
				val err = r.error ?: ""
				if(err.contains("kapatılmış") || err.contains("geçersiz") || err.contains("başka bir cihaz") || err.contains("Çok fazla"))
				{
					val now = SystemClock.elapsedRealtime()
					if(now - lastNoticeAt > NOTICE_COOLDOWN_MS)
					{
						lastNoticeAt = now
						main.post { showNotice("Efex Sub: $err") }
					}
				}
				return@execute
			}
			val tr = result.translations.firstOrNull()
			if(tr != null)
			{
				cache.put(key, tr)
				main.post { if(currentKey == key && settings.enabled) showSubtitle(tr) }
			}
			else
			{
				val now = SystemClock.elapsedRealtime()
				if(now - lastNoticeAt > NOTICE_COOLDOWN_MS)
				{
					lastNoticeAt = now
					val msg = when(result.reason)
					{
						"daily_limit" -> "Bugünkü çeviri hakkın doldu"
						else -> result.message ?: "Çeviri şu an yapılamıyor"
					}
					main.post { showNotice(msg) }
				}
			}
		}
	}

	private fun similar(a: String, b: String): Boolean
	{
		if(a == b) return true
		val longer = max(a.length, b.length)
		if(longer == 0) return true
		if(min(a.length, b.length).toDouble() / longer < SAME_TEXT_RATIO - 0.2) return false
		return 1.0 - levenshtein(a, b).toDouble() / longer >= SAME_TEXT_RATIO
	}

	private fun levenshtein(a: String, b: String): Int
	{
		var prev = IntArray(b.length + 1) { it }
		var cur = IntArray(b.length + 1)
		for(i in 1..a.length)
		{
			cur[0] = i
			for(j in 1..b.length)
			{
				val cost = if(a[i - 1] == b[j - 1]) 0 else 1
				cur[j] = min(min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost)
			}
			val t = prev; prev = cur; cur = t
		}
		return prev[b.length]
	}

	// ---- arayüz (ana iş parçacığı)

	private fun showSubtitle(text: String)
	{
		subtitleView.text = text
		if(subtitleView.visibility != View.VISIBLE)
		{
			subtitleView.alpha = 0f
			subtitleView.visibility = View.VISIBLE
			subtitleView.animate().alpha(1f).setDuration(120).start()
		}
	}

	private fun hideSubtitle()
	{
		subtitleView.animate().cancel()
		subtitleView.visibility = View.GONE
	}

	private fun showNotice(text: String)
	{
		noticeView.text = text
		noticeView.visibility = View.VISIBLE
		noticeView.alpha = 1f
		noticeView.animate().alpha(0f).setStartDelay(4000).setDuration(600)
			.withEndAction { noticeView.visibility = View.GONE }.start()
	}

	private fun debug(text: String)
	{
		val v = debugView ?: return
		if(!settings.showStatus)
			return
		main.post {
			v.visibility = View.VISIBLE
			v.text = "Efex Sub · $text"
		}
	}
}
