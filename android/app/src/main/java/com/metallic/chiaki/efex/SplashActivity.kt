// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: animasyonlu açılış ekranı. Kayıtlı kodu arka planda doğrular,
// sonra konsol listesine ya da giriş ekranına geçer.

package com.metallic.chiaki.efex

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import androidx.appcompat.app.AppCompatActivity
import com.metallic.chiaki.databinding.ActivityEfexSplashBinding
import com.metallic.chiaki.main.MainActivity
import java.util.concurrent.Executors

class SplashActivity : AppCompatActivity()
{
	private lateinit var binding: ActivityEfexSplashBinding
	private val handler = Handler(Looper.getMainLooper())
	private var animationDone = false
	private var target: Class<*>? = null
	private var navigated = false

	override fun onCreate(savedInstanceState: Bundle?)
	{
		super.onCreate(savedInstanceState)
		binding = ActivityEfexSplashBinding.inflate(layoutInflater)
		setContentView(binding.root)
		@Suppress("DEPRECATION")
		window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
			or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
			or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)

		// Kodu animasyonla aynı anda doğrula
		val ctx = applicationContext
		if(EfexClient.savedCode(ctx) == null)
			target = EfexLoginActivity::class.java
		else
			Executors.newSingleThreadExecutor().execute {
				val r = EfexClient.verifySaved(ctx)
				if(r.reason == "rejected")
					EfexClient.logout(ctx)
				handler.post {
					target = if(r.reason == "rejected") EfexLoginActivity::class.java else MainActivity::class.java
					maybeNavigate()
				}
			}

		binding.root.post { animate() }
		// Ağ çok yavaşsa en fazla 6 sn bekle
		handler.postDelayed({
			if(target == null)
				target = MainActivity::class.java
			animationDone = true
			maybeNavigate()
		}, 6000)
	}

	private fun animate()
	{
		val efex = binding.logoEfex
		val sub = binding.logoSub
		val bar = binding.logoBar
		val credit = binding.logoCredit
		val dist = resources.displayMetrics.density * 60

		efex.alpha = 0f; efex.translationX = -dist
		sub.alpha = 0f; sub.translationX = dist
		bar.scaleX = 0f; bar.alpha = 0f
		credit.alpha = 0f; credit.translationY = dist / 3

		val words = AnimatorSet().apply {
			playTogether(
				ObjectAnimator.ofFloat(efex, View.ALPHA, 1f),
				ObjectAnimator.ofFloat(efex, View.TRANSLATION_X, 0f),
				ObjectAnimator.ofFloat(sub, View.ALPHA, 1f),
				ObjectAnimator.ofFloat(sub, View.TRANSLATION_X, 0f)
			)
			duration = 650
			interpolator = OvershootInterpolator(1.2f)
		}
		val barIn = AnimatorSet().apply {
			playTogether(
				ObjectAnimator.ofFloat(bar, View.SCALE_X, 1f),
				ObjectAnimator.ofFloat(bar, View.ALPHA, 1f)
			)
			duration = 450
			interpolator = DecelerateInterpolator()
		}
		val creditIn = AnimatorSet().apply {
			playTogether(
				ObjectAnimator.ofFloat(credit, View.ALPHA, 1f),
				ObjectAnimator.ofFloat(credit, View.TRANSLATION_Y, 0f)
			)
			duration = 500
			interpolator = DecelerateInterpolator()
		}
		// "Sub" kelimesi bir kez nabız gibi atar
		val pulse = AnimatorSet().apply {
			playTogether(
				ObjectAnimator.ofFloat(sub, View.SCALE_X, 1f, 1.08f, 1f),
				ObjectAnimator.ofFloat(sub, View.SCALE_Y, 1f, 1.08f, 1f)
			)
			duration = 420
		}
		AnimatorSet().apply {
			playSequentially(words, barIn, creditIn, pulse)
			start()
		}
		handler.postDelayed({
			animationDone = true
			maybeNavigate()
		}, 2600)
	}

	private fun maybeNavigate()
	{
		val t = target ?: return
		if(!animationDone || navigated)
			return
		navigated = true
		binding.logoGroup.animate().alpha(0f).setDuration(250).withEndAction {
			startActivity(Intent(this, t))
			@Suppress("DEPRECATION")
			overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
			finish()
		}.start()
	}

	override fun onDestroy()
	{
		handler.removeCallbacksAndMessages(null)
		super.onDestroy()
	}
}
