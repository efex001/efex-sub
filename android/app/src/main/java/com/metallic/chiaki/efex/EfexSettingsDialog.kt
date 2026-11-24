// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: oyun açıkken altyazı ayar paneli. Ekranın solunda açılır, görüntü
// görünür kalır; okuma bölgesi ve Türkçe altyazının yeri anında güncellenir.

package com.metallic.chiaki.efex

import android.app.Activity
import android.app.Dialog
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.math.roundToInt

class EfexSettingsDialog(
	private val activity: Activity,
	initial: EfexSettings,
	/** Her değişiklikte çağrılır (önizleme) */
	private val onPreview: (EfexSettings) -> Unit,
	/** Panel kapanınca: kaydedildiyse yeni ayar, iptal edildiyse null */
	private val onClose: (EfexSettings?) -> Unit
)
{
	private val original = initial.copy()
	private var saved = false
	private val dialog = Dialog(activity)
	private val form = EfexSettingsForm(activity, initial) { onPreview(it) }

	private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, activity.resources.displayMetrics).roundToInt()

	fun show()
	{
		val accent = Color.parseColor("#FFB020")
		val content = LinearLayout(activity).apply {
			orientation = LinearLayout.VERTICAL
			setPadding(dp(20f), dp(16f), dp(20f), dp(16f))
		}
		content.addView(TextView(activity).apply {
			text = "Efex Sub · Altyazı ayarları"
			setTextColor(accent)
			setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
		})
		content.addView(TextView(activity).apply {
			text = "Turuncu çerçeve okunan bölge. İngilizce altyazı çerçevenin içinde kalmalı."
			setTextColor(Color.parseColor("#8B95A3"))
			setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
			setPadding(0, dp(4f), 0, dp(4f))
		})
		content.addView(form.build())

		val buttons = LinearLayout(activity).apply {
			orientation = LinearLayout.HORIZONTAL
			setPadding(0, dp(12f), 0, 0)
		}
		fun button(label: String, primary: Boolean, action: () -> Unit) = Button(activity).apply {
			text = label
			isAllCaps = false
			setTextColor(if(primary) Color.parseColor("#111111") else Color.parseColor("#E8ECF1"))
			backgroundTintList = ColorStateList.valueOf(if(primary) accent else Color.parseColor("#252B35"))
			setOnClickListener { action() }
			layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(6f) }
		}
		buttons.addView(button("Kaydet", true) { saved = true; dialog.dismiss() })
		buttons.addView(button("İptal", false) { dialog.dismiss() })
		content.addView(buttons)

		dialog.setContentView(ScrollView(activity).apply { addView(content) })
		dialog.setOnDismissListener {
			if(saved)
				onClose(form.current.copy())
			else
			{
				onPreview(original.copy())
				onClose(null)
			}
		}
		dialog.window?.let { w ->
			w.setBackgroundDrawable(GradientDrawable().apply {
				setColor(Color.parseColor("#F0151920"))
				cornerRadius = dp(16f).toFloat()
			})
			w.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
			w.setGravity(Gravity.START or Gravity.CENTER_VERTICAL)
			w.setLayout(dp(400f), ViewGroup.LayoutParams.WRAP_CONTENT)
			w.attributes = w.attributes.apply { x = dp(16f) }
		}
		dialog.show()
		onPreview(form.current.copy())
	}
}
