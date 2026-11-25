// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: oyun sesini dublaj için dinler ve dublaj sırasında oyun sesini kısar.
//
// Dinleme: ses tek kanala indirilip ~8 kHz'e seyreltilir ve son 2 saniyesi bir halkada tutulur.
// Kotlin tarafı bir altyazı belirdiğinde nativeAnalyze() ile son ~1,5 saniyenin ses düzeyini ve
// konuşanın temel frekansını (ses kalınlığı) ister; buna göre Türkçe ses seçilir.

#include "efex-audio.h"

#include <jni.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <mutex>
#include <vector>

namespace
{
	constexpr int TARGET_RATE = 8000;
	constexpr int RING_SECONDS = 2;
	constexpr int RING_SIZE = TARGET_RATE * RING_SECONDS;

	std::mutex ring_mutex;
	float ring[RING_SIZE];
	size_t ring_pos = 0;
	size_t ring_filled = 0;
	// Seyreltme durumu
	uint32_t decim_step = 6;
	uint32_t decim_counter = 0;
	float decim_acc = 0.0f;

	std::atomic<float> game_gain{1.0f};
}

extern "C" void efex_audio_tap(const int16_t *buf, size_t samples_count, uint32_t channels, uint32_t rate)
{
	if(!buf || !channels || !rate)
		return;
	uint32_t step = std::max<uint32_t>(1, rate / TARGET_RATE);
	size_t frames = samples_count / channels;
	std::lock_guard<std::mutex> lock(ring_mutex);
	if(step != decim_step)
	{
		decim_step = step;
		decim_counter = 0;
		decim_acc = 0.0f;
	}
	for(size_t f = 0; f < frames; f++)
	{
		float mono = 0.0f;
		for(uint32_t c = 0; c < channels; c++)
			mono += buf[f * channels + c];
		decim_acc += mono / (32768.0f * channels);
		if(++decim_counter >= decim_step)
		{
			ring[ring_pos] = decim_acc / decim_step; // basit ortalama: aynı zamanda alçak geçiren süzgeç
			ring_pos = (ring_pos + 1) % RING_SIZE;
			ring_filled = std::min<size_t>(ring_filled + 1, RING_SIZE);
			decim_counter = 0;
			decim_acc = 0.0f;
		}
	}
}

extern "C" void efex_audio_apply_gain(int16_t *buf, size_t samples_count)
{
	float g = game_gain.load(std::memory_order_relaxed);
	if(g >= 0.999f)
		return;
	for(size_t i = 0; i < samples_count; i++)
		buf[i] = static_cast<int16_t>(buf[i] * g);
}

/** Bir pencerenin temel frekansı (Hz), sesli değilse 0 */
static float pitch_of(const float *x, int n)
{
	// İnsan konuşması: ~70–400 Hz
	const int min_lag = TARGET_RATE / 400;
	const int max_lag = TARGET_RATE / 70;
	if(n <= max_lag * 2)
		return 0.0f;
	double energy = 0.0;
	for(int i = 0; i < n; i++)
		energy += x[i] * x[i];
	if(energy <= 1e-9)
		return 0.0f;
	// Her gecikme için benzerlik; alt harmonik (oktav) hatasına düşmemek için en yükseğe
	// yakın (%90) olan en KISA gecikme seçilir
	std::vector<double> norms(max_lag + 1, 0.0);
	double best = 0.0;
	for(int lag = min_lag; lag <= max_lag; lag++)
	{
		double acc = 0.0, e1 = 0.0, e2 = 0.0;
		for(int i = 0; i + lag < n; i++)
		{
			acc += x[i] * x[i + lag];
			e1 += x[i] * x[i];
			e2 += x[i + lag] * x[i + lag];
		}
		norms[lag] = acc / std::sqrt(e1 * e2 + 1e-12);
		best = std::max(best, norms[lag]);
	}
	int best_lag = 0;
	for(int lag = min_lag + 1; lag < max_lag; lag++)
	{
		// yerel tepe ve en yükseğe yakın
		if(norms[lag] >= 0.9 * best && norms[lag] >= norms[lag - 1] && norms[lag] >= norms[lag + 1])
		{
			best_lag = lag;
			best = norms[lag];
			break;
		}
	}
	return (best > 0.6 && best_lag > 0) ? static_cast<float>(TARGET_RATE) / best_lag : 0.0f;
}

extern "C" JNIEXPORT void JNICALL
Java_com_metallic_chiaki_efex_EfexAudio_nativeSetGameGain(JNIEnv *env, jclass clazz, jfloat gain)
{
	game_gain.store(std::clamp(static_cast<float>(gain), 0.0f, 1.0f), std::memory_order_relaxed);
}

/** out = [ses düzeyi dB, temel frekans Hz (0: bulunamadı), sesli pencere oranı 0..1] */
extern "C" void efex_audio_analyze(int window_ms, float out[3])
{
	int n = std::clamp<int>(window_ms, 200, RING_SECONDS * 1000) * TARGET_RATE / 1000;
	std::vector<float> x;
	{
		std::lock_guard<std::mutex> lock(ring_mutex);
		n = std::min<int>(n, static_cast<int>(ring_filled));
		x.resize(n);
		for(int i = 0; i < n; i++)
			x[i] = ring[(ring_pos + RING_SIZE - n + i) % RING_SIZE];
	}

	out[0] = -120.0f;
	out[1] = 0.0f;
	out[2] = 0.0f;
	if(n > 0)
	{
		double sum = 0.0;
		for(float v : x)
			sum += v * v;
		out[0] = 10.0f * std::log10(static_cast<float>(sum / n) + 1e-12f);

		// 40 ms'lik pencereler, 20 ms adımla; sadece yeterince yüksek olanlar
		const int win = TARGET_RATE * 40 / 1000;
		const int hop = TARGET_RATE * 20 / 1000;
		std::vector<float> pitches;
		int windows = 0;
		for(int start = 0; start + win <= n; start += hop)
		{
			double e = 0.0;
			for(int i = 0; i < win; i++)
				e += x[start + i] * x[start + i];
			float db = 10.0f * std::log10(static_cast<float>(e / win) + 1e-12f);
			if(db < out[0] - 6.0f || db < -50.0f)
				continue;
			windows++;
			float p = pitch_of(&x[start], win);
			if(p > 0.0f)
				pitches.push_back(p);
		}
		if(!pitches.empty())
		{
			std::nth_element(pitches.begin(), pitches.begin() + pitches.size() / 2, pitches.end());
			out[1] = pitches[pitches.size() / 2];
		}
		out[2] = windows ? static_cast<float>(pitches.size()) / windows : 0.0f;
	}
}

extern "C" JNIEXPORT jfloatArray JNICALL
Java_com_metallic_chiaki_efex_EfexAudio_nativeAnalyze(JNIEnv *env, jclass clazz, jint window_ms)
{
	float out[3];
	efex_audio_analyze(window_ms, out);
	jfloatArray r = env->NewFloatArray(3);
	if(r)
		env->SetFloatArrayRegion(r, 0, 3, out);
	return r;
}
