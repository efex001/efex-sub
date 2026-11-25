// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: Türkçe dublaj (beta).
//
// - Konuşanın orijinal sesi dinlenir (kalınlık, ses düzeyi) ve buna benzeyen bir Türkçe ses seçilir.
// - Aynı karakter (benzer ses kalınlığı) oyun boyunca aynı Türkçe sesle konuşur.
// - Ses sunucudan parça parça gelir ve gelir gelmez çalar; daha önce üretilmiş replikler havuzdan
//   anında gelir. Türkçe konuşurken oyunun sesi kısılır.
// - Gecikme birikmesin diye: yeni replik gelince eskisinin uzun bir kısmı kaldıysa kesilir.

package com.metallic.chiaki.efex

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.PlaybackParams
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.metallic.chiaki.BuildConfig
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.roundToInt

/** Bir replik anındaki oyun sesi ölçümü */
class VoiceSample(val db: Float, val pitchHz: Float, val voiced: Float)

class DubbingEngine(context: Context, private val onNotice: (String) -> Unit)
{
	companion object
	{
		private const val TAG = "EfexDub"
		private const val SAMPLE_RATE = 24000
		/** Bu kadardan fazlası kaldıysa yeni replik gelince eskisi kesilir */
		private const val MAX_REMAINING_MS = 700
		private const val PLAYBACK_SPEED = 1.08f
		private const val NOTICE_COOLDOWN_MS = 60_000L

		/** Sunucuyla aynı liste (server/src/core.js VOICES) */
		val VOICES = linkedMapOf(
			"man_low" to listOf("Charon", "Algenib", "Orus", "Alnilam", "Rasalgethi"),
			"man_mid" to listOf("Iapetus", "Schedar", "Umbriel", "Achird", "Sadaltager"),
			"man_high" to listOf("Puck", "Fenrir", "Zubenelgenubi", "Sadachbia", "Enceladus"),
			"woman_low" to listOf("Gacrux", "Kore", "Vindemiatrix"),
			"woman_mid" to listOf("Aoede", "Despina", "Erinome", "Pulcherrima", "Sulafat"),
			"woman_high" to listOf("Leda", "Zephyr", "Laomedeia", "Achernar", "Autonoe", "Callirrhoe"))

		/** Orijinal sesin kalınlığına göre grup */
		fun personaFor(pitchHz: Float): String = when
		{
			pitchHz <= 0f -> "man_mid"
			pitchHz < 105f -> "man_low"
			pitchHz < 135f -> "man_mid"
			pitchHz < 165f -> "man_high"
			pitchHz < 195f -> "woman_low"
			pitchHz < 235f -> "woman_mid"
			else -> "woman_high"
		}
	}

	private class Speaker(var pitch: Float, val persona: String, val voice: String)

	private val appContext = context.applicationContext
	private val executor = Executors.newSingleThreadExecutor()
	private val main = Handler(Looper.getMainLooper())
	private val generation = AtomicInteger(0)
	private val speakers = mutableListOf<Speaker>()
	private var loudnessAvg = Float.NaN
	private var lastNoticeAt = 0L

	@Volatile var enabled = false
		set(value)
		{
			field = value
			if(!value)
				stopCurrent()
		}
	/** Türkçe konuşurken oyun sesinin seviyesi, 0..1 */
	@Volatile var gameVolumeWhileSpeaking = 0.25f

	@Volatile private var track: AudioTrack? = null
	@Volatile private var framesWritten = 0L

	/** Altyazı netleştiği anda çağrılır: o an konuşan kişinin sesini ölçer */
	fun sampleVoice(): VoiceSample? = try
	{
		val r = EfexAudio.nativeAnalyze(1200)
		VoiceSample(r[0], r[1], r[2])
	}
	catch(e: Throwable)
	{
		Log.w(TAG, "Ses ölçülemedi", e)
		null
	}

	/** Çeviri gelince çağrılır */
	fun speak(turkish: String, sample: VoiceSample?)
	{
		if(!enabled || turkish.isBlank())
			return
		val (persona, voice) = pickVoice(sample)
		val style = styleFor(sample)
		val gen = generation.incrementAndGet()
		// Eski replik çok uzun kaldıysa kes, kısa kaldıysa bitmesine izin ver
		if(remainingMs() > MAX_REMAINING_MS)
			stopCurrent()
		executor.execute { play(gen, turkish, voice, persona, style) }
	}

	fun release()
	{
		enabled = false
		executor.shutdownNow()
		setGameGain(1f)
	}

	// ---- ses seçimi

	@Synchronized
	private fun pickVoice(sample: VoiceSample?): Pair<String, String>
	{
		val pitch = sample?.takeIf { it.voiced >= 0.25f }?.pitchHz ?: 0f
		if(pitch <= 0f)
		{
			// Ölçülemediyse son konuşanın sesiyle devam et
			speakers.lastOrNull()?.let { return it.persona to it.voice }
			return "man_mid" to VOICES.getValue("man_mid")[0]
		}
		val persona = personaFor(pitch)
		// Aynı kişi: aynı grupta ve ses kalınlığı %7'den yakın
		val known = speakers.filter { it.persona == persona }.minByOrNull { abs(it.pitch - pitch) }
		if(known != null && abs(known.pitch - pitch) / known.pitch < 0.07f)
		{
			known.pitch = known.pitch * 0.8f + pitch * 0.2f
			speakers.remove(known)
			speakers.add(known) // en son konuşan sonda
			return known.persona to known.voice
		}
		// Yeni kişi: grubunda, ses kalınlığına göre belirlenen ses; başka biri kullanıyorsa sıradaki
		val list = VOICES.getValue(persona)
		val used = speakers.filter { it.persona == persona }.map { it.voice }.toSet()
		var idx = (pitch / 6f).roundToInt() % list.size
		for(i in list.indices)
		{
			val v = list[(idx + i) % list.size]
			if(v !in used) { idx = (idx + i) % list.size; break }
		}
		val sp = Speaker(pitch, persona, list[idx])
		speakers.add(sp)
		if(speakers.size > 24)
			speakers.removeAt(0)
		return sp.persona to sp.voice
	}

	@Synchronized
	private fun styleFor(sample: VoiceSample?): String
	{
		val db = sample?.db ?: return "normal"
		if(db < -60f)
			return "normal"
		val avg = if(loudnessAvg.isNaN()) db else loudnessAvg
		loudnessAvg = avg * 0.9f + db * 0.1f
		return when
		{
			db > avg + 6f -> "loud"
			db < avg - 8f -> "quiet"
			else -> "normal"
		}
	}

	// ---- çalma

	private fun remainingMs(): Long
	{
		val t = track ?: return 0L
		return try
		{
			val played = t.playbackHeadPosition.toLong() and 0xffffffffL
			((framesWritten - played).coerceAtLeast(0) * 1000 / SAMPLE_RATE)
		}
		catch(e: Exception) { 0L }
	}

	@Synchronized
	private fun stopCurrent()
	{
		val t = track ?: return
		track = null
		try { t.pause(); t.flush(); t.release() } catch(e: Exception) {}
		setGameGain(1f)
	}

	private fun setGameGain(g: Float)
	{
		try { EfexAudio.nativeSetGameGain(g) } catch(e: Throwable) {}
	}

	private fun newTrack(): AudioTrack
	{
		val minBuf = AudioTrack.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
		val t = AudioTrack.Builder()
			.setAudioAttributes(AudioAttributes.Builder()
				.setUsage(AudioAttributes.USAGE_GAME)
				.setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
				.build())
			.setAudioFormat(AudioFormat.Builder()
				.setSampleRate(SAMPLE_RATE)
				.setEncoding(AudioFormat.ENCODING_PCM_16BIT)
				.setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
				.build())
			.setBufferSizeInBytes(maxOf(minBuf * 4, SAMPLE_RATE)) // ~0,5 sn
			.setTransferMode(AudioTrack.MODE_STREAM)
			.build()
		try { t.playbackParams = PlaybackParams().setSpeed(PLAYBACK_SPEED) } catch(e: Exception) {}
		return t
	}

	/** Dublaj iş parçacığında çalışır */
	private fun play(gen: Int, text: String, voice: String, persona: String, style: String)
	{
		// Önceki replik bitmeden başlamasın (ama yeni bir replik geldiyse bu atlanır)
		while(remainingMs() > 0 && generation.get() == gen)
			SystemClock.sleep(30)
		if(generation.get() != gen || !enabled)
			return
		stopCurrent()

		val code = EfexClient.savedCode(appContext) ?: return
		var conn: HttpURLConnection? = null
		try
		{
			conn = URL(BuildConfig.EFEX_SERVER + "/api/speak").openConnection() as HttpURLConnection
			conn.requestMethod = "POST"
			conn.connectTimeout = 6000
			conn.readTimeout = 10000
			conn.doOutput = true
			conn.setRequestProperty("content-type", "application/json")
			conn.setRequestProperty("x-efex-code", code)
			conn.setRequestProperty("x-efex-device", EfexClient.deviceId(appContext))
			val body = JSONObject().put("text", text).put("voice", voice).put("persona", persona).put("style", style)
			conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
			val status = conn.responseCode
			if(status != 200)
			{
				val err = conn.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
				val reason = try { JSONObject(err).optString("reason") } catch(e: Exception) { "" }
				Log.i(TAG, "Dublaj yapılamadı: $status $err")
				notice(if(reason == "daily_limit") "Bugünkü hakkın doldu, dublaj yarın devam eder" else "Dublaj şu an yapılamıyor")
				return
			}

			val t = newTrack()
			synchronized(this) { track = t; framesWritten = 0 }
			var started = false
			var carry = -1 // tek kalan bayt (16 bit örnek ikiye bölünürse)
			val buf = ByteArray(8192)
			val input = conn.inputStream
			try
			{
				while(generation.get() == gen && track === t)
				{
					val n = input.read(buf)
					if(n < 0)
						break
					var data = buf
					var len = n
					if(carry >= 0)
					{
						data = ByteArray(n + 1)
						data[0] = carry.toByte()
						System.arraycopy(buf, 0, data, 1, n)
						len = n + 1
						carry = -1
					}
					if(len % 2 == 1)
					{
						carry = data[len - 1].toInt() and 0xff
						len -= 1
					}
					if(len == 0)
						continue
					if(!started)
					{
						setGameGain(gameVolumeWhileSpeaking)
						t.play()
						started = true
					}
					t.write(data, 0, len)
					framesWritten += len / 2
				}
			}
			finally
			{
				try { input.close() } catch(e: Exception) {}
			}
			// Yeni bir replik geldiyse kalan kısmı o replik bekleyip devralır
			if(generation.get() != gen)
				return
			// Bitene kadar bekle, sonra oyun sesini geri aç
			while(generation.get() == gen && track === t && remainingMs() > 0)
				SystemClock.sleep(30)
			if(generation.get() == gen && track === t)
			{
				SystemClock.sleep(150)
				stopCurrent()
			}
		}
		catch(e: Exception)
		{
			Log.w(TAG, "Dublaj hatası", e)
			if(generation.get() == gen)
				stopCurrent()
		}
		finally
		{
			conn?.disconnect()
		}
	}

	private fun notice(text: String)
	{
		val now = SystemClock.elapsedRealtime()
		if(now - lastNoticeAt < NOTICE_COOLDOWN_MS)
			return
		lastNoticeAt = now
		main.post { onNotice(text) }
	}
}
