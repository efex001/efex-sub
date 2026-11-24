// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: oyuna girmeden, örnek bir görüntü üzerinde altyazı ayarı.
// İlk girişten sonra bir kez açılır; sonra ana ekrandaki menüden ulaşılır.

package com.metallic.chiaki.efex

import android.content.Intent
import android.os.Bundle
import android.util.TypedValue
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import com.metallic.chiaki.databinding.ActivityEfexSetupBinding
import com.metallic.chiaki.main.MainActivity

class EfexSetupActivity : AppCompatActivity()
{
	companion object
	{
		/** true: girişten sonra açıldı, kaydedince konsol listesine geçilir */
		const val EXTRA_FIRST_RUN = "efex_first_run"
	}

	private lateinit var binding: ActivityEfexSetupBinding
	private lateinit var form: EfexSettingsForm
	private var current: EfexSettings = EfexSettings()
	private var lastW = 0
	private var lastH = 0

	override fun onCreate(savedInstanceState: Bundle?)
	{
		super.onCreate(savedInstanceState)
		binding = ActivityEfexSetupBinding.inflate(layoutInflater)
		setContentView(binding.root)

		current = EfexSettings.load(this)
		form = EfexSettingsForm(this, current) {
			current = it
			updatePreview()
		}
		binding.formContainer.addView(form.build())

		binding.saveButton.setOnClickListener {
			form.current.save(this)
			done()
		}
		binding.cancelButton.setOnClickListener { done() }
		binding.previewVideo.addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
			// Sadece boyut değişince yeniden konumla, yoksa her yerleşimde döngüye girer
			if(v.width != lastW || v.height != lastH)
			{
				lastW = v.width
				lastH = v.height
				v.post { updatePreview() }
			}
		}
		binding.versionInfo.text = "Efex Sub ${com.metallic.chiaki.BuildConfig.VERSION_NAME} · prod. by Efekan Uçan" +
			(EfexClient.savedName(this)?.let { "\nGiriş: $it" } ?: "") +
			"\nAçık kaynak (AGPL-3.0), Momiji tabanlı: ${com.metallic.chiaki.BuildConfig.EFEX_SOURCE_URL.removePrefix("https://")}"
		binding.saveButton.requestFocus()
	}

	private fun done()
	{
		if(intent.getBooleanExtra(EXTRA_FIRST_RUN, false))
			startActivity(Intent(this, MainActivity::class.java))
		finish()
	}

	/** Örnek görüntüyü TV'deki gerçek oranlarla çizer */
	private fun updatePreview()
	{
		val pv = binding.previewVideo
		val w = pv.width
		val h = pv.height
		if(w == 0 || h == 0)
			return
		val st = current
		// Önizleme, tam ekran TV görüntüsünün küçültülmüş hali
		val screenWidth = resources.displayMetrics.widthPixels.coerceAtLeast(1)
		val scale = w.toFloat() / screenWidth

		// Örnek İngilizce altyazı: tipik oyun altyazısı gibi alttan ~%7, yükseklik ~%3,5
		binding.previewEnglish.setTextSize(TypedValue.COMPLEX_UNIT_PX, h * 0.035f)
		(binding.previewEnglish.layoutParams as FrameLayout.LayoutParams).let {
			it.bottomMargin = (h * 0.07f).toInt()
			binding.previewEnglish.layoutParams = it
		}

		// Kenardaki harita (HUD): okuma bölgesinin dışında kalması gerektiğini gösterir
		(binding.previewMinimap.layoutParams as FrameLayout.LayoutParams).let {
			val size = (h * 0.22f).toInt()
			it.width = size
			it.height = size
			it.leftMargin = (w * 0.03f).toInt()
			it.bottomMargin = (h * 0.05f).toInt()
			binding.previewMinimap.layoutParams = it
		}

		(binding.previewRegion.layoutParams as FrameLayout.LayoutParams).let {
			it.leftMargin = (w * st.regionLeft).toInt()
			it.topMargin = (h * st.regionTop).toInt()
			it.width = (w * (st.regionRight - st.regionLeft)).toInt()
			it.height = (h * (st.regionBottom - st.regionTop)).toInt()
			binding.previewRegion.layoutParams = it
		}

		val tr = binding.previewTurkish
		tr.visibility = if(st.enabled) android.view.View.VISIBLE else android.view.View.INVISIBLE
		val spPx = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, st.textSizeSp.toFloat(), resources.displayMetrics)
		tr.setTextSize(TypedValue.COMPLEX_UNIT_PX, spPx * scale)
		tr.background?.mutate()?.alpha = (st.backgroundAlpha * 255).toInt()
		tr.maxWidth = (w * 0.9f).toInt()
		(tr.layoutParams as FrameLayout.LayoutParams).let {
			it.bottomMargin = (h * st.subtitleBottom).toInt()
			tr.layoutParams = it
		}
	}
}
