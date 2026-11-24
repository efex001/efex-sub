// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: uygulama içi güncelleme. GitHub'daki son sürümün version.json dosyasına
// bakar; yeni sürüm varsa sorar, APK'yı indirir ve Android'in kurulum ekranını açar.

package com.metallic.chiaki.efex

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.core.content.FileProvider
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.metallic.chiaki.BuildConfig
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import kotlin.math.roundToInt

class UpdateInfo(val versionCode: Int, val versionName: String, val apkUrl: String, val notes: String)

object UpdateChecker
{
	private const val TAG = "EfexUpdate"
	private val executor = Executors.newSingleThreadExecutor()
	private val main = Handler(Looper.getMainLooper())

	/** Bu açılışta zaten soruldu mu (her açılışta bir kez sorar) */
	private var askedThisRun = false
	/** Kurulum izni için ayarlara gidildiyse, dönünce kaldığı yerden devam eder */
	private var pendingInstall: UpdateInfo? = null

	private fun open(url: String): HttpURLConnection
	{
		var current = url
		// GitHub, release dosyalarını başka bir alan adına yönlendirir; yönlendirmeleri elle izle
		repeat(5) {
			val conn = URL(current).openConnection() as HttpURLConnection
			conn.connectTimeout = 10_000
			conn.readTimeout = 20_000
			conn.instanceFollowRedirects = false
			conn.setRequestProperty("User-Agent", "EfexSub/${BuildConfig.VERSION_NAME}")
			val code = conn.responseCode
			if(code in 300..399)
			{
				val loc = conn.getHeaderField("Location") ?: throw IllegalStateException("Yönlendirme adresi yok")
				conn.disconnect()
				current = URL(URL(current), loc).toString()
			}
			else
				return conn
		}
		throw IllegalStateException("Çok fazla yönlendirme")
	}

	/** Ağ isteği yapar. Yeni sürüm yoksa ya da bakılamazsa null. */
	fun fetchNewer(): UpdateInfo?
	{
		return try
		{
			val conn = open(BuildConfig.EFEX_UPDATE_URL)
			if(conn.responseCode != 200)
				return null
			val json = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
			conn.disconnect()
			val info = UpdateInfo(
				json.getInt("versionCode"),
				json.optString("versionName"),
				json.getString("apk"),
				json.optString("notes"))
			if(info.versionCode > BuildConfig.VERSION_CODE) info else null
		}
		catch(e: Exception)
		{
			Log.i(TAG, "Güncelleme kontrolü yapılamadı: ${e.message}")
			null
		}
	}

	/** Ekran açılınca çağrılır: yeni sürüm varsa sorar */
	fun checkAndPrompt(activity: Activity)
	{
		pendingInstall?.let {
			// Kurulum izni ekranından dönüldü
			if(canInstall(activity))
			{
				pendingInstall = null
				download(activity, it)
			}
			return
		}
		if(askedThisRun)
			return
		askedThisRun = true
		executor.execute {
			val info = fetchNewer() ?: return@execute
			main.post {
				if(activity.isFinishing || activity.isDestroyed)
					return@post
				val msg = buildString {
					append("Efex Sub ${info.versionName} hazır. Şu an ${BuildConfig.VERSION_NAME} kullanıyorsun.")
					if(info.notes.isNotBlank())
						append("\n\nYenilikler:\n${info.notes.trim()}")
				}
				MaterialAlertDialogBuilder(activity)
					.setTitle("Yeni sürüm var")
					.setMessage(msg)
					.setPositiveButton("Güncelle") { _, _ -> startUpdate(activity, info) }
					.setNegativeButton("Sonra", null)
					.show()
			}
		}
	}

	private fun canInstall(activity: Activity) =
		Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

	private fun startUpdate(activity: Activity, info: UpdateInfo)
	{
		if(canInstall(activity))
		{
			download(activity, info)
			return
		}
		MaterialAlertDialogBuilder(activity)
			.setTitle("Bir kerelik izin")
			.setMessage("Efex Sub'ın kendini güncelleyebilmesi için açılacak ekranda \"Bu kaynaktan izin ver\" seçeneğini aç, sonra geri dön.")
			.setPositiveButton("Ayarları aç") { _, _ ->
				pendingInstall = info
				try
				{
					activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
				}
				catch(e: ActivityNotFoundException)
				{
					try { activity.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS)) }
					catch(e2: ActivityNotFoundException) { activity.startActivity(Intent(Settings.ACTION_SETTINGS)) }
				}
			}
			.setNegativeButton("Vazgeç", null)
			.show()
	}

	private fun download(activity: Activity, info: UpdateInfo)
	{
		val dp = { v: Float -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, activity.resources.displayMetrics).roundToInt() }
		val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }
		val label = TextView(activity).apply { text = "İndiriliyor…" }
		val box = LinearLayout(activity).apply {
			orientation = LinearLayout.VERTICAL
			setPadding(dp(24f), dp(16f), dp(24f), dp(8f))
			addView(label)
			addView(bar)
		}
		val dialog: AlertDialog = MaterialAlertDialogBuilder(activity)
			.setTitle("Efex Sub ${info.versionName}")
			.setView(box)
			.setCancelable(false)
			.show()

		executor.execute {
			try
			{
				val dir = File(activity.cacheDir, "updates").apply { mkdirs() }
				val file = File(dir, "efex-sub.apk")
				val conn = open(info.apkUrl)
				if(conn.responseCode != 200)
					throw IllegalStateException("HTTP ${conn.responseCode}")
				val total = conn.contentLengthLong
				var read = 0L
				conn.inputStream.use { input ->
					file.outputStream().use { out ->
						val buf = ByteArray(64 * 1024)
						var lastPct = -1
						while(true)
						{
							val n = input.read(buf)
							if(n < 0) break
							out.write(buf, 0, n)
							read += n
							if(total > 0)
							{
								val pct = (read * 100 / total).toInt()
								if(pct != lastPct)
								{
									lastPct = pct
									main.post {
										bar.progress = pct
										label.text = "İndiriliyor… %$pct"
									}
								}
							}
						}
					}
				}
				conn.disconnect()
				main.post {
					dialog.dismiss()
					install(activity, file)
				}
			}
			catch(e: Exception)
			{
				Log.w(TAG, "İndirme hatası", e)
				main.post {
					dialog.dismiss()
					MaterialAlertDialogBuilder(activity)
						.setTitle("Güncelleme indirilemedi")
						.setMessage("İnternet bağlantını kontrol edip uygulamayı yeniden açınca tekrar sorulacak.")
						.setPositiveButton("Tamam", null)
						.show()
					askedThisRun = false
				}
			}
		}
	}

	private fun install(activity: Activity, file: File)
	{
		val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
		val intent = Intent(Intent.ACTION_VIEW)
			.setDataAndType(uri, "application/vnd.android.package-archive")
			.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
		activity.startActivity(intent)
	}
}
