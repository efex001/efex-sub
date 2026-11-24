# Efex Sub — Sunucu Kurulumu (telefondan)

Toplam süre: yaklaşık 20 dakika. Bilgisayar gerekmez. Cloudflare ve Google panellerindeki menü adları zamanla biraz değişebilir; aşağıdaki isimler yol göstermek için.

Sistem: Arkadaşların sadece kendilerine verdiğin kodu girer. Bütün çeviriler **senin** Gemini anahtarınla yapılır, masraf sende. Ortak havuz sayesinde bir cümle bir kez ücretlendirilir, sonra herkese bedava gelir.

## 1. Cloudflare hesabı
- **dash.cloudflare.com** adresinden ücretsiz hesap aç. Kart bilgisi istemez. Sunucu ve veritabanı ücretsiz planda kalır.

## 2. Veritabanını oluştur
- Sol menü → **Storage & Databases → D1** → **Create database**
- İsim: `efex-sub` → Oluştur.
- Tabloları sen kurmuyorsun, sunucu ilk açılışta kendisi oluşturuyor.

## 3. Sunucuyu (Worker) oluştur
- Sol menü → **Workers & Pages** → **Create** → **Worker** ("Hello World" şablonu)
- İsim: `efex-sub` → **Deploy**
- **Edit code**'a bas. İçindeki örnek kodun hepsini sil.
- `worker.js` dosyasını aç, **tümünü seç → kopyala**, editöre yapıştır → **Deploy**.

## 4. Veritabanını sunucuya bağla
- Worker sayfası → **Settings → Bindings → Add → D1 database**
- Variable name: `DB` (büyük harf, aynen böyle)
- Database: `efex-sub` → Kaydet.

## 5. Gemini API anahtarı (ücretli)
Not: Gemini uygulama aboneliğin bu anahtarı kapsamaz; API kullanımı ayrı faturalanır.

1. **aistudio.google.com** → Google hesabınla gir → **Get API key → Create API key**. Anahtarı bir yere kopyala.
2. Aynı sayfada anahtarın projesinde **Set up billing** (Faturalandırmayı ayarla) → kartını bağla. Ücretli planda sınırlar yükselir ve gönderilen metinler Google'ın modellerini eğitmekte kullanılmaz.
3. Faturalandırmayı açınca aboneliğinin Cloud kredisi verip vermediğine bak; veriyorsa masrafın bir kısmını o karşılar.
4. **Bütçe uyarısı kur:** console.cloud.google.com → **Billing → Budgets & alerts → Create budget** → aylık **5 USD**. Bu bir harcama durdurucu değil, uyarıdır: aşılırsa e-posta gelir. Asıl harcama freni, paneldeki kişi başı günlük haktır.

## 6. Ayarları gir
Worker sayfası → **Settings → Variables and Secrets → Add**

| Ad | Tür | Değer |
|---|---|---|
| `ADMIN_PASSWORD` | Secret | Yönetim paneli şifren: **en az 12 karakter**, başka yerde kullanmadığın bir şifre |
| `ADMIN_PATH` | Secret | Panelin gizli adresi, ör. `panel-k7m2x9`. Panel artık `/admin` yerine `/panel-k7m2x9` adresinde açılır; adresi sadece sen bilirsin |
| `GEMINI_KEY` | Secret | 5. adımda aldığın anahtar |

İsteğe bağlı:
- `DEFAULT_DAILY_LIMIT` → yeni kodlar için kişi başı günlük karakter hakkı. Yazmazsan **60000** (yaklaşık 1.300 yeni cümle, günde 3–4 saat yoğun oyun; en kötü durumda kişi başı günde yaklaşık 0,25 USD).
- `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` → Google model adlarını değiştirirse buradan güncellenir. Varsayılanlar: `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite`. Panelde "model bulunamadı" uyarısı görürsen AI Studio'daki güncel Flash-Lite adını `GEMINI_MODEL`'e yaz.

## 7. Dene
- Telefon tarayıcısında: `https://efex-sub.<hesap-adın>.workers.dev/api/ping`
  → `{"ok":true,"service":"Efex Sub",...}` görmelisin.
- Yönetim paneli: `https://efex-sub.<hesap-adın>.workers.dev/<ADMIN_PATH>` (ADMIN_PATH girmediysen `/admin`)
  → Şifreni gir. "Gemini anahtarı: tanımlı" yazmalı. → İlk arkadaş kodunu oluştur; kod otomatik kopyalanır.
- İpucu: Paneli Safari'de açıp **Paylaş → Ana Ekrana Ekle** dersen uygulama gibi açılır.

## Çeviri sırası
1. **Ortak havuz** — daha önce çevrilmiş cümle anında ve bedava gelir, haktan düşmez.
2. **Senin anahtarın** — önce yeni Flash-Lite modeli, o yoğunsa ya da tıkanırsa bir önceki Flash-Lite modeli.
3. Arkadaşın günlük hakkı dolarsa ya da Google tarafında sorun olursa yeni cümleler çevrilmez; TV'de orijinal İngilizce altyazı görünür ve küçük bir uyarı çıkar. Havuzdaki cümleler gelmeye devam eder. Günlük haklar Türkiye saatiyle gece yarısı yenilenir.

## Güvenlik
- Panel şifresi IP başına 5 yanlış denemede 30 dakika kilitlenir; doğru şifre de o süre boyunca reddedilir.
- Geçersiz arkadaş kodu IP başına 10 denemede 30 dakika kilitlenir.
- Gemini anahtarı, panel şifresi ve panel adresi sadece Cloudflare'de gizli değişken olarak durur; uygulamada ya da GitHub'da yer almaz.
- Panel başka sitelerin içine gömülemez, arama motorlarına kapalıdır.

## TV'ye kurulum adresi
`https://efex-sub.<hesap-adın>.workers.dev/indir` → her zaman GitHub'daki son APK'yı indirir. Bu adresi **aftv.news** sitesinde kısaltıp Downloader için 5–6 haneli bir kod alabilirsin.

## Paneldeki özellikler
- **Kod oluştur:** Her arkadaşa `EFEX-XXXX-XXXX` biçiminde kod ve günlük karakter hakkı.
- **Cihaz kilidi:** Kod ilk girildiği TV'ye kilitlenir, başkasına verilip kullanılamaz. Arkadaşın TV değiştirirse **Cihazı sıfırla**.
- **Kapat / Aç / Sil / Sınırı değiştir:** Her kodu ayrı yönetirsin.
- **Uyarılar:** Anahtarda sorun olursa (faturalandırma, geçersiz anahtar, model adı) ya da biri günlük hakkını doldurursa en üstte görünür.
- **Çeviri havuzu:** Kötü bir çeviri görürsen arayıp **elle düzeltirsin**; herkes düzeltilmiş halini görür.

## Sıradaki adım
TV uygulaması (Android TV / Google TV APK) bu sunucuya bağlanacak. Uygulamaya sadece sunucu adresi ve arkadaşın kodu girilecek.
