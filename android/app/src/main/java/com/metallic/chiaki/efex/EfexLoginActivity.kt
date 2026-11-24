// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: arkadaş kodu ile giriş ekranı (TV kumandasıyla kullanılabilir)

package com.metallic.chiaki.efex

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import androidx.appcompat.app.AppCompatActivity
import com.metallic.chiaki.databinding.ActivityEfexLoginBinding
import java.util.concurrent.Executors

class EfexLoginActivity : AppCompatActivity()
{
	private lateinit var binding: ActivityEfexLoginBinding
	private val executor = Executors.newSingleThreadExecutor()
	private val handler = Handler(Looper.getMainLooper())
	private var busy = false

	override fun onCreate(savedInstanceState: Bundle?)
	{
		super.onCreate(savedInstanceState)
		binding = ActivityEfexLoginBinding.inflate(layoutInflater)
		setContentView(binding.root)

		binding.loginButton.setOnClickListener { submit() }
		binding.codeInput.setOnEditorActionListener { _, actionId, event ->
			if(actionId == EditorInfo.IME_ACTION_DONE || event?.keyCode == KeyEvent.KEYCODE_ENTER)
			{
				submit()
				true
			}
			else
				false
		}
		binding.codeInput.requestFocus()
	}

	private fun submit()
	{
		if(busy)
			return
		val raw = binding.codeInput.text.toString().trim().uppercase().replace(" ", "")
		// "EFEXABCD1234" gibi tiresiz yazılırsa düzelt
		val code = if(!raw.contains("-") && raw.length == 12 && raw.startsWith("EFEX"))
			"EFEX-${raw.substring(4, 8)}-${raw.substring(8)}"
		else
			raw
		if(code.length < 8)
		{
			binding.loginStatus.text = "Kodu eksiksiz yaz (ör. EFEX-AB12-CD34)"
			return
		}
		busy = true
		binding.loginStatus.text = ""
		binding.loginProgress.visibility = View.VISIBLE
		binding.loginButton.isEnabled = false
		val ctx = applicationContext
		executor.execute {
			val r = EfexClient.login(ctx, code)
			handler.post {
				busy = false
				binding.loginProgress.visibility = View.GONE
				binding.loginButton.isEnabled = true
				if(r.error == null)
				{
					// İlk girişte altyazı ayarı ekranı, sonra konsol listesi
					startActivity(Intent(this, EfexSetupActivity::class.java).putExtra(EfexSetupActivity.EXTRA_FIRST_RUN, true))
					finish()
				}
				else
				{
					binding.loginStatus.text = r.error
					binding.codeInput.requestFocus()
				}
			}
		}
	}

	override fun onDestroy()
	{
		executor.shutdown()
		super.onDestroy()
	}
}
