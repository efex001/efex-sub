// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: sunucu bağlantısı (giriş kodu, cihaz kimliği, çeviri)

package com.metallic.chiaki.efex

import android.content.Context
import android.content.SharedPreferences
import com.metallic.chiaki.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

class EfexResult<T>(val value: T?, val error: String?, val reason: String? = null)

class TranslationResult(
	val translations: List<String?>,
	/** "daily_limit", "quota", "invalid_key", ... when some lines could not be translated */
	val reason: String?,
	val message: String?
)

object EfexClient
{
	private const val PREFS = "efex_sub"
	private const val KEY_CODE = "code"
	private const val KEY_NAME = "name"
	private const val KEY_DEVICE = "device_id"
	private const val TIMEOUT_MS = 8000

	private fun prefs(context: Context): SharedPreferences =
		context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

	fun savedCode(context: Context): String? = prefs(context).getString(KEY_CODE, null)
	fun savedName(context: Context): String? = prefs(context).getString(KEY_NAME, null)

	fun logout(context: Context) = prefs(context).edit().remove(KEY_CODE).remove(KEY_NAME).apply()

	/** Bu kuruluma özel, rastgele bir kimlik. Kod ilk girildiği cihaza kilitlenir. */
	fun deviceId(context: Context): String
	{
		val p = prefs(context)
		p.getString(KEY_DEVICE, null)?.let { return it }
		val id = "tv-" + UUID.randomUUID().toString()
		p.edit().putString(KEY_DEVICE, id).apply()
		return id
	}

	private fun post(context: Context, path: String, code: String, body: JSONObject): Pair<Int, JSONObject?>
	{
		val conn = URL(BuildConfig.EFEX_SERVER + path).openConnection() as HttpURLConnection
		try
		{
			conn.requestMethod = "POST"
			conn.connectTimeout = TIMEOUT_MS
			conn.readTimeout = TIMEOUT_MS
			conn.doOutput = true
			conn.setRequestProperty("content-type", "application/json")
			conn.setRequestProperty("x-efex-code", code)
			conn.setRequestProperty("x-efex-device", deviceId(context))
			conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
			val status = conn.responseCode
			val stream = if(status >= 400) conn.errorStream else conn.inputStream
			val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
			val json = try { JSONObject(text) } catch(e: Exception) { null }
			return Pair(status, json)
		}
		finally
		{
			conn.disconnect()
		}
	}

	/** Ağ isteği yapar, ana iş parçacığında çağırma. */
	fun login(context: Context, rawCode: String): EfexResult<String>
	{
		val code = rawCode.trim().uppercase()
		return try
		{
			val (status, json) = post(context, "/api/login", code, JSONObject())
			if(status == 200 && json != null && json.optBoolean("ok"))
			{
				val name = json.optString("name")
				prefs(context).edit().putString(KEY_CODE, code).putString(KEY_NAME, name).apply()
				EfexResult(name, null)
			}
			else
				EfexResult(null, json?.optString("error")?.takeIf { it.isNotEmpty() } ?: "Sunucu hatası ($status)")
		}
		catch(e: Exception)
		{
			EfexResult(null, "Sunucuya bağlanılamadı. İnternet bağlantını kontrol et.")
		}
	}

	/** Kayıtlı kodu sunucuda doğrular. Ağ yoksa (null hata değil) geçerli sayılır. */
	fun verifySaved(context: Context): EfexResult<String>
	{
		val code = savedCode(context) ?: return EfexResult(null, "Kod yok")
		return try
		{
			val (status, json) = post(context, "/api/login", code, JSONObject())
			when
			{
				status == 200 && json != null && json.optBoolean("ok") -> EfexResult(json.optString("name"), null)
				status in listOf(401, 403) -> EfexResult(null, json?.optString("error") ?: "Kod geçersiz", "rejected")
				else -> EfexResult(savedName(context), null) // sunucu geçici sorunluysa oyunu engelleme
			}
		}
		catch(e: Exception)
		{
			EfexResult(savedName(context), null)
		}
	}

	/** Ağ isteği yapar, ana iş parçacığında çağırma. */
	fun translate(context: Context, lines: List<String>): EfexResult<TranslationResult>
	{
		val code = savedCode(context) ?: return EfexResult(null, "Kod yok")
		return try
		{
			val (status, json) = post(context, "/api/translate", code, JSONObject().put("lines", JSONArray(lines)))
			if(status != 200 || json == null || !json.optBoolean("ok"))
				return EfexResult(null, json?.optString("error") ?: "HTTP $status")
			val arr = json.getJSONArray("translations")
			val out = (0 until arr.length()).map { if(arr.isNull(it)) null else arr.getString(it) }
			EfexResult(TranslationResult(out, json.optString("reason").ifEmpty { null }, json.optString("message").ifEmpty { null }), null)
		}
		catch(e: Exception)
		{
			EfexResult(null, e.message ?: "Ağ hatası")
		}
	}
}
