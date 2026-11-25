// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: oyun sesini dublaj için dinler (konuşanın ses özellikleri) ve dublaj
// sırasında oyun sesini kısar.

#ifndef EFEX_AUDIO_H
#define EFEX_AUDIO_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Kod çözücü iş parçacığından: gelen her ses çerçevesi (iç içe kanallar) */
void efex_audio_tap(const int16_t *buf, size_t samples_count, uint32_t channels, uint32_t rate);
/** out = [ses düzeyi dB, temel frekans Hz (0: bulunamadı), sesli pencere oranı 0..1] */
void efex_audio_analyze(int window_ms, float out[3]);
/** Ses akışı geri çağrısından: çalınacak örneklere oyun sesi kazancını uygular */
void efex_audio_apply_gain(int16_t *buf, size_t samples_count);

#ifdef __cplusplus
}
#endif

#endif
