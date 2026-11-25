// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: altyazı ayar satırları. Hem oyun dışındaki ayar ekranında hem de
// oyun içi panelde aynı form kullanılır. TV kumandası: yukarı/aşağı satır,
// sağ/sol değer.

package com.metallic.chiaki.efex

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import kotlin.math.roundToInt

class EfexSettingsForm(
	private val context: Context,
	initial: EfexSettings,
	/** Her değişiklikte çağrılır */
	private val onChange: (EfexSettings) -> Unit
)
{
	var current: EfexSettings = initial.copy()
		private set

	private val rows = mutableListOf<() -> Unit>()

	private val accent = Color.parseColor("#FFB020")
	private val textColor = Color.parseColor("#E8ECF1")
	private val dimColor = Color.parseColor("#8B95A3")

	private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, context.resources.displayMetrics).roundToInt()

	/** Ayarı dışarıdan değiştirir (ör. "Varsayılan") ve formu tazeler */
	fun set(settings: EfexSettings)
	{
		current = settings.copy()
		rows.forEach { it() }
		onChange(current.copy())
	}

	fun build(): LinearLayout
	{
		val content = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }

		content.addView(label("Hazır ayarlar", 14f, dimColor))
		val presets = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
		presets.addView(smallButton("Standart") {
			set(EfexSettings(enabled = current.enabled, showStatus = current.showStatus, dubEnabled = current.dubEnabled, dubGameVolume = current.dubGameVolume))
		})
		presets.addView(smallButton("Altyazı yukarıda") {
			set(current.copy().apply { regionTop = 0.55f; regionBottom = 0.85f; subtitleBottom = 0.17f })
		})
		presets.addView(smallButton("Büyük yazı") { set(current.copy().apply { textSizeSp = 32 }) })
		content.addView(presets)

		addCheck(content, "Türkçe altyazı açık", { current.enabled }) { current.enabled = it }

		addSlider(content, "Okunan bölge: üst kenar", 30, 95, { (current.regionTop * 100).roundToInt() },
			{ current.regionTop = it / 100f; if(current.regionBottom < current.regionTop + 0.05f) current.regionBottom = current.regionTop + 0.05f }) { "%$it" }
		addSlider(content, "Okunan bölge: alt kenar", 35, 100, { (current.regionBottom * 100).roundToInt() },
			{ current.regionBottom = it / 100f; if(current.regionTop > current.regionBottom - 0.05f) current.regionTop = current.regionBottom - 0.05f }) { "%$it" }
		addSlider(content, "Okunan bölge: genişlik", 30, 100, { (current.regionWidth * 100).roundToInt() },
			{ current.regionWidth = it / 100f }) { "%$it" }
		addSlider(content, "Türkçe altyazının yüksekliği", 0, 60, { (current.subtitleBottom * 100).roundToInt() },
			{ current.subtitleBottom = it / 100f }) { "alttan %$it" }
		addSlider(content, "Yazı boyutu", 14, 48, { current.textSizeSp }, { current.textSizeSp = it }) { "$it" }
		addSlider(content, "Kutu koyuluğu", 0, 100, { (current.backgroundAlpha * 100).roundToInt() },
			{ current.backgroundAlpha = it / 100f }) { "%$it" }

		// ---- Dublaj (beta)
		val dubHeader = LinearLayout(context).apply {
			orientation = LinearLayout.HORIZONTAL
			gravity = Gravity.CENTER_VERTICAL
			setPadding(0, dp(18f), 0, dp(2f))
		}
		dubHeader.addView(TextView(context).apply {
			text = "Türkçe dublaj"
			setTextColor(textColor)
			setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
		})
		dubHeader.addView(betaBadge())
		content.addView(dubHeader)
		content.addView(label("Karakterler, orijinal seslerine benzeyen farklı Türkçe seslerle konuşur. Türkçe konuşurken oyunun sesi kısılır.", 12f, dimColor))
		addCheck(content, "Dublajı aç", { current.dubEnabled }) { current.dubEnabled = it }
		addSlider(content, "Dublaj sırasında oyun sesi", 0, 100, { (current.dubGameVolume * 100).roundToInt() },
			{ current.dubGameVolume = it / 100f }) { "%$it" }

		addCheck(content, "Durum satırını göster (test için)", { current.showStatus }) { current.showStatus = it }
		return content
	}

	/** Turuncu "BETA" etiketi */
	private fun betaBadge() = TextView(context).apply {
		text = "BETA"
		setTextColor(Color.parseColor("#111111"))
		setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
		typeface = android.graphics.Typeface.DEFAULT_BOLD
		letterSpacing = 0.08f
		setPadding(dp(7f), dp(1f), dp(7f), dp(1f))
		background = android.graphics.drawable.GradientDrawable().apply {
			setColor(accent)
			cornerRadius = dp(8f).toFloat()
		}
		layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8f) }
	}

	private fun label(text: String, sizeSp: Float, color: Int) = TextView(context).apply {
		this.text = text
		setTextColor(color)
		setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
		setPadding(0, dp(8f), 0, dp(2f))
	}

	private fun smallButton(text: String, action: () -> Unit) = Button(context).apply {
		this.text = text
		isAllCaps = false
		setTextColor(textColor)
		setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
		backgroundTintList = ColorStateList.valueOf(Color.parseColor("#252B35"))
		setOnClickListener { action() }
		layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(6f) }
	}

	private fun addCheck(parent: LinearLayout, label: String, get: () -> Boolean, set: (Boolean) -> Unit)
	{
		val box = CheckBox(context).apply {
			text = label
			setTextColor(textColor)
			buttonTintList = ColorStateList.valueOf(accent)
			isChecked = get()
		}
		box.setOnCheckedChangeListener { _, checked ->
			if(checked == get())
				return@setOnCheckedChangeListener
			set(checked)
			onChange(current.copy())
		}
		rows.add { if(box.isChecked != get()) box.isChecked = get() }
		parent.addView(box)
	}

	private fun addSlider(parent: LinearLayout, label: String, min: Int, max: Int, get: () -> Int, set: (Int) -> Unit, format: (Int) -> String)
	{
		val title = TextView(context).apply {
			setTextColor(textColor)
			setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
			setPadding(0, dp(10f), 0, 0)
		}
		fun refreshTitle(v: Int) { title.text = "$label: ${format(v)}" }
		val bar = SeekBar(context).apply {
			this.max = max - min
			keyProgressIncrement = 1
			progress = get() - min
			progressTintList = ColorStateList.valueOf(accent)
			thumbTintList = ColorStateList.valueOf(accent)
			isFocusable = true
		}
		bar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener
		{
			override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean)
			{
				if(!fromUser)
					return
				set(progress + min)
				// Bir ayar diğerini itebilir (üst/alt kenar), hepsini tazele
				rows.forEach { it() }
				onChange(current.copy())
			}
			override fun onStartTrackingTouch(seekBar: SeekBar?) {}
			override fun onStopTrackingTouch(seekBar: SeekBar?) {}
		})
		refreshTitle(get())
		rows.add {
			val v = get()
			if(bar.progress != v - min)
				bar.progress = v - min
			refreshTitle(v)
		}
		parent.addView(title)
		parent.addView(bar)
	}
}
