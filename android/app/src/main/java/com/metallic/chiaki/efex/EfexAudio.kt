// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: oyun sesine yerel (C++) erişim, bkz. cpp/efex-audio.cpp

package com.metallic.chiaki.efex

object EfexAudio
{
	init
	{
		System.loadLibrary("chiaki-jni")
	}

	/** Oyun sesinin seviyesi, 0..1 (dublaj konuşurken kısmak için) */
	@JvmStatic external fun nativeSetGameGain(gain: Float)

	/** Son [windowMs] ms'lik oyun sesi: [ses düzeyi dB, temel frekans Hz (0: yok), sesli oran 0..1] */
	@JvmStatic external fun nativeAnalyze(windowMs: Int): FloatArray
}
