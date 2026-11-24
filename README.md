# Efex Sub

PS5 oyunlarını Android TV / Google TV'ye aktarır ve İngilizce altyazıları anlık olarak Türkçeye çevirip oyunun üstünde gösterir.

prod. by Efekan Uçan

## Nasıl çalışır
1. TV, PS5'in görüntüsünü Remote Play ile alır (Momiji motoru).
2. Ekranın altyazı bölgesi TV'nin içinde okunur (Google ML Kit, cihaz içi).
3. Okunan cümle Efex Sub sunucusuna gider; ortak havuzda varsa anında, yoksa Gemini ile çevrilir.
4. Türkçe altyazı İngilizcenin üstüne yazılır.

Giriş için yöneticiden alınan arkadaş kodu gerekir.

## Kurulum (Android TV / Google TV)
TV'de **Downloader** uygulamasını aç ve şu adresi gir:
`https://efex-sub.efekan-ucan.workers.dev/indir`
(Her zaman en son sürümü indirir.) Sonraki güncellemeleri uygulama kendisi bildirir.

## Derleme
`main` dalına her gönderimde GitHub Actions APK'yı derler. `versionName` yeni bir değerse sürümü **Releases** altında yayınlar; uygulama güncellemeyi buradaki `version.json`'dan öğrenir.

İmza anahtarı depoda değil, **Settings → Secrets and variables → Actions** altında durur: `EFEX_KEYSTORE_B64`, `EFEX_KEYSTORE_PW`.

## Sunucu
`server/` klasöründe (Cloudflare Worker). Kurulum: `server/KURULUM.md`. Sunucunun anahtarları ve şifreleri depoda değil, Cloudflare'de gizli değişken olarak durur.

## Lisans ve emeği geçenler
Efex Sub, [Momiji](https://github.com/yazanj082/momiji) üzerine kuruludur (Chiaki ve chiaki-ng tabanlı) ve onun gibi **GNU AGPL-3.0** lisanslıdır. Uygulamayı verdiğin herkes bu kaynak koduna erişebilmelidir. Momiji'nin orijinal açıklaması: [README.momiji.md](README.momiji.md).

Yazı tipi: Poppins (SIL Open Font License 1.1), Indian Type Foundry.
