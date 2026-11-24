// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: altyazı okuma bölgesi ve Türkçe altyazı görünümü ayarları

package com.metallic.chiaki.efex

import android.content.Context

class EfexSettings(
	/** Okuma bölgesinin üst ve alt kenarı, görüntü yüksekliğinin oranı olarak (0 = üst, 1 = alt) */
	var regionTop: Float = DEFAULT_REGION_TOP,
	var regionBottom: Float = DEFAULT_REGION_BOTTOM,
	/** Okuma bölgesinin genişliği, ortalanmış (1 = tam genişlik) */
	var regionWidth: Float = DEFAULT_REGION_WIDTH,
	/** Türkçe altyazının görüntünün altından yüksekliği, görüntü yüksekliğinin oranı */
	var subtitleBottom: Float = DEFAULT_SUBTITLE_BOTTOM,
	var textSizeSp: Int = DEFAULT_TEXT_SIZE,
	/** Altyazı kutusunun koyuluğu, 0..1 */
	var backgroundAlpha: Float = DEFAULT_BG_ALPHA,
	var enabled: Boolean = true,
	var showStatus: Boolean = false
)
{
	val regionLeft: Float get() = (1f - regionWidth) / 2f
	val regionRight: Float get() = 1f - regionLeft

	companion object
	{
		const val DEFAULT_REGION_TOP = 0.68f
		const val DEFAULT_REGION_BOTTOM = 0.97f
		const val DEFAULT_REGION_WIDTH = 0.76f
		const val DEFAULT_SUBTITLE_BOTTOM = 0.05f
		const val DEFAULT_TEXT_SIZE = 24
		const val DEFAULT_BG_ALPHA = 0.9f

		private const val PREFS = "efex_sub_settings"

		fun load(context: Context): EfexSettings
		{
			val p = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
			return EfexSettings(
				regionTop = p.getFloat("regionTop", DEFAULT_REGION_TOP),
				regionBottom = p.getFloat("regionBottom", DEFAULT_REGION_BOTTOM),
				regionWidth = p.getFloat("regionWidth", DEFAULT_REGION_WIDTH),
				subtitleBottom = p.getFloat("subtitleBottom", DEFAULT_SUBTITLE_BOTTOM),
				textSizeSp = p.getInt("textSizeSp", DEFAULT_TEXT_SIZE),
				backgroundAlpha = p.getFloat("backgroundAlpha", DEFAULT_BG_ALPHA),
				enabled = p.getBoolean("enabled", true),
				showStatus = p.getBoolean("showStatus", false)
			).also { it.sanitize() }
		}
	}

	fun sanitize()
	{
		regionTop = regionTop.coerceIn(0f, 0.95f)
		regionBottom = regionBottom.coerceIn(regionTop + 0.05f, 1f)
		regionWidth = regionWidth.coerceIn(0.3f, 1f)
		subtitleBottom = subtitleBottom.coerceIn(0f, 0.6f)
		textSizeSp = textSizeSp.coerceIn(14, 48)
		backgroundAlpha = backgroundAlpha.coerceIn(0f, 1f)
	}

	fun save(context: Context)
	{
		sanitize()
		context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
			.putFloat("regionTop", regionTop)
			.putFloat("regionBottom", regionBottom)
			.putFloat("regionWidth", regionWidth)
			.putFloat("subtitleBottom", subtitleBottom)
			.putInt("textSizeSp", textSizeSp)
			.putFloat("backgroundAlpha", backgroundAlpha)
			.putBoolean("enabled", enabled)
			.putBoolean("showStatus", showStatus)
			.apply()
	}

	fun copy() = EfexSettings(regionTop, regionBottom, regionWidth, subtitleBottom, textSizeSp, backgroundAlpha, enabled, showStatus)
}
