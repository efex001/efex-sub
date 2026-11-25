/**
 * Efex Sub — sunucu (Cloudflare Worker)
 *
 * Görevleri:
 *  - Arkadaş kodlarıyla giriş (her kod tek cihaza kilitlenir)
 *  - Ortak çeviri havuzu (bir cümle bir kez çevrilir, herkes hazırını alır)
 *  - Çeviri sırası: ortak havuz → senin Gemini anahtarın (kişi başı günlük hak dahilinde)
 *    → hak dolarsa o satır çevrilmez, TV orijinal İngilizce altyazıyı göstermeye devam eder.
 *  - /admin adresinde telefondan kullanılan yönetim paneli
 *
 * Cloudflare ayarları:
 *  - D1 veritabanı, değişken adı: DB                         (zorunlu)
 *  - Secret ADMIN_PASSWORD : yönetim paneli şifresi          (zorunlu)
 *  - Secret GEMINI_KEY     : senin Gemini API anahtarın      (zorunlu)
 *  - GEMINI_MODEL          : ana model (varsayılan gemini-3.5-flash-lite)
 *  - GEMINI_FALLBACK_MODEL : ana model tıkanınca denenen (varsayılan gemini-3.1-flash-lite)
 *  - PROVIDER              : sunucu anahtarı için "gemini" | "deepl" | "anthropic" (varsayılan gemini)
 *  - DEEPL_KEY / ANTHROPIC_KEY / ANTHROPIC_MODEL : PROVIDER'a göre
 *  - DEFAULT_DAILY_LIMIT   : yeni kodlar için kişi başı günlük karakter hakkı (varsayılan 60000)
 *  - ADMIN_PATH            : panelin gizli adresi (ör. "panel-7k2q" → /panel-7k2q). Yazılırsa /admin kapanır
 *  - APK_URL               : /indir adresinin yönlendireceği APK (varsayılan GitHub'daki son sürüm)
 *  - TTS_MODEL             : dublaj (beta) için Gemini ses modeli; yazılmazsa sırayla denenir
 *
 * Güvenlik: yanlış panel şifresi IP başına 5 denemede 30 dk, geçersiz arkadaş kodu
 * IP başına 10 denemede 30 dk kilitlenir.
 */

const VERSION = "0.6.1";
const MAX_LINES_PER_REQUEST = 8;
const MAX_LINE_LENGTH = 400;

// ---------------------------------------------------------------- yardımcılar

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function err(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

function today() {
  // Türkiye saatine göre gün (UTC+3)
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Altyazı satırını havuz anahtarı için normalleştirir. */
export function normalizeLine(s) {
  return String(s || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function newCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // karışan harfler yok (0/O, 1/I)
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `EFEX-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export const REASON_TEXT = {
  quota: "Gemini sınırı doldu",
  invalid_key: "Anahtar geçersiz",
  server: "Çeviri servisi yanıt vermedi",
  model: "Model bulunamadı",
  bad_output: "Çeviri yanıtı bozuk geldi",
  daily_limit: "Günlük çeviri hakkın doldu",
  no_key: "Sunucuda çeviri anahtarı tanımlı değil",
};

// ---------------------------------------------------------------- veritabanı

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS members (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      daily_limit INTEGER NOT NULL,
      device_id TEXT,
      created_at TEXT NOT NULL,
      last_seen TEXT,
      has_own_key INTEGER NOT NULL DEFAULT 0,
      key_state TEXT,
      key_state_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS usage (
      code TEXT NOT NULL,
      day TEXT NOT NULL,
      chars INTEGER NOT NULL DEFAULT 0,
      lines INTEGER NOT NULL DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0,
      own_chars INTEGER NOT NULL DEFAULT 0,
      device_lines INTEGER NOT NULL DEFAULT 0,
      tts_lines INTEGER NOT NULL DEFAULT 0,
      tts_cached INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (code, day)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS translations (
      hash TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      provider TEXT NOT NULL,
      edited INTEGER NOT NULL DEFAULT 0,
      hits INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audio (
      hash TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      voice TEXT NOT NULL,
      style TEXT NOT NULL,
      rate INTEGER NOT NULL,
      pcm BLOB NOT NULL,
      model TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS fails (
      scope TEXT NOT NULL,
      ip TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      first_at INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (scope, ip)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS status (
      name TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    )`),
  ]);
  // 0.1.0 ile kurulmuş veritabanlarına yeni sütunları ekle (zaten varsa hata verir, yok sayılır)
  const migrations = [
    "ALTER TABLE members ADD COLUMN has_own_key INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE members ADD COLUMN key_state TEXT",
    "ALTER TABLE members ADD COLUMN key_state_at TEXT",
    "ALTER TABLE usage ADD COLUMN own_chars INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE usage ADD COLUMN device_lines INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE usage ADD COLUMN tts_lines INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE usage ADD COLUMN tts_cached INTEGER NOT NULL DEFAULT 0",
  ];
  // Eski sürüm ses havuzu kayıtlarını sil (0.6.0'da yönlendirme de okunuyordu)
  migrations.push("DELETE FROM audio WHERE style NOT LIKE '%/v2'");
  for (const m of migrations) {
    try {
      await db.prepare(m).run();
    } catch {
      /* sütun zaten var */
    }
  }
  schemaReady = true;
}

async function setStatus(db, name, value) {
  await db
    .prepare(
      "INSERT INTO status (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .bind(name, value, nowIso())
    .run();
}

// ---------------------------------------------------------------- deneme kilidi

const LIMITS = {
  admin: { max: 5, windowSec: 15 * 60, lockSec: 30 * 60 },
  code: { max: 10, windowSec: 15 * 60, lockSec: 30 * 60 },
};

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "unknown";
}

/** Kilitliyse kalan saniye, değilse 0 */
async function lockedFor(db, scope, ip) {
  const row = await db.prepare("SELECT locked_until FROM fails WHERE scope = ? AND ip = ?").bind(scope, ip).first();
  const now = Math.floor(Date.now() / 1000);
  return row && row.locked_until > now ? row.locked_until - now : 0;
}

async function recordFail(db, scope, ip) {
  const lim = LIMITS[scope];
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare("SELECT count, first_at FROM fails WHERE scope = ? AND ip = ?").bind(scope, ip).first();
  let count = 1;
  let first = now;
  if (row && now - row.first_at < lim.windowSec) {
    count = row.count + 1;
    first = row.first_at;
  }
  const lockedUntil = count >= lim.max ? now + lim.lockSec : 0;
  await db
    .prepare(
      `INSERT INTO fails (scope, ip, count, first_at, locked_until) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, ip) DO UPDATE SET count = excluded.count, first_at = excluded.first_at, locked_until = excluded.locked_until`
    )
    .bind(scope, ip, lockedUntil ? 0 : count, first, lockedUntil)
    .run();
}

async function clearFails(db, scope, ip) {
  await db.prepare("DELETE FROM fails WHERE scope = ? AND ip = ?").bind(scope, ip).run();
}

function lockedResponse(seconds) {
  return err(`Çok fazla hatalı deneme. ${Math.ceil(seconds / 60)} dakika sonra tekrar dene.`, 429, { retryAfter: seconds });
}

// ---------------------------------------------------------------- çeviri sağlayıcıları

export class ProviderError extends Error {
  /** kind: quota | invalid_key | model | server | bad_output */
  constructor(kind, message, detail) {
    super(message || kind);
    this.kind = kind;
    this.detail = detail || "";
  }
}

const STYLE_PROMPT = `Sen bir video oyunu altyazı çevirmenisin. Oyun: suç ve aksiyon temalı, açık dünya, Amerikan argosu bol.
İngilizce altyazı satırlarını doğal, akıcı, günlük konuşma Türkçesine çevir.
Kurallar:
- Kelime kelime değil, anlam ve duyguyla çevir; Türk oyuncunun ağzından çıkacak gibi olsun.
- Argo ve küfürleri benzer sertlikte Türkçe karşılıklarıyla çevir, yumuşatma ya da sertleştirme.
- Kişi adlarını, lakapları, marka ve yer adlarını (ör. Vice City, Leonida) çevirme.
- Altyazıya sığacak kadar kısa tut.
- Satırın başında konuşan kişinin adı varsa (ör. "LUCIA: ..."), adı aynen bırak, sadece cümleyi çevir.
- Yalnızca JSON dizisi döndür: girişle aynı sırada ve aynı sayıda Türkçe metin. Açıklama ekleme.`;

function parseJsonArray(text, expected) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new ProviderError("bad_output", "Çeviri yanıtı okunamadı");
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ProviderError("bad_output", "Çeviri yanıtı JSON değil");
  }
  if (!Array.isArray(arr) || arr.length !== expected) throw new ProviderError("bad_output", "Satır sayısı tutmadı");
  return arr.map((s) => String(s).trim());
}

/** Gemini/Gemma hata kodlarını sınıflandırır. */
async function classifyGeminiError(res, model) {
  const text = await res.text().catch(() => "");
  let msg = text;
  try {
    const e = JSON.parse(text).error;
    const reason = e?.details?.find((d) => d.reason)?.reason;
    msg = `${e?.message || ""}${reason ? ` [${reason}]` : ""}`;
  } catch {}
  const detail = `${model}: HTTP ${res.status} ${msg}`.replace(/\s+/g, " ").slice(0, 300);
  if (res.status === 429) return new ProviderError("quota", "429", detail);
  if (/API_KEY_INVALID|API key not valid|API_KEY_SERVICE_BLOCKED|ACCESS_TOKEN_TYPE_UNSUPPORTED|PERMISSION_DENIED|UNAUTHENTICATED/i.test(text) || res.status === 401 || res.status === 403) {
    return new ProviderError("invalid_key", String(res.status), detail);
  }
  if (res.status === 404 || res.status === 400) return new ProviderError("model", `${res.status}`, detail);
  return new ProviderError("server", String(res.status), detail);
}

async function geminiCall(lines, key, model) {
  const isGemma = model.toLowerCase().startsWith("gemma");
  // Gemma modelleri sistem talimatı ve JSON modu desteklemiyor; talimat mesajın içine yazılır.
  const body = isGemma
    ? {
        contents: [{ role: "user", parts: [{ text: `${STYLE_PROMPT}\n\nSatırlar:\n${JSON.stringify(lines)}` }] }],
        generationConfig: { temperature: 0.3 },
      }
    : {
        systemInstruction: { parts: [{ text: STYLE_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(lines) }] }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
      };
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ProviderError("server", String(e.message || e));
  }
  if (!res.ok) throw await classifyGeminiError(res, model);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return parseJsonArray(text, lines.length);
}

function geminiModels(env) {
  const list = [env.GEMINI_MODEL || "gemini-3.5-flash-lite", env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite"];
  return [...new Set(list.filter(Boolean))];
}

/**
 * Bir anahtarla model zincirini dener. Sınır dolarsa sıradaki modele geçer,
 * sunucu hatasında bir kez kısa bekleyip tekrar dener. Anahtar geçersizse hemen durur.
 */
export async function translateWithGeminiKey(lines, key, env) {
  let lastErr = new ProviderError("model");
  let sawQuota = false;
  const details = [];
  for (const model of geminiModels(env)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await geminiCall(lines, key, model);
        return { out, provider: model };
      } catch (e) {
        if (!(e instanceof ProviderError)) e = new ProviderError("server", String(e.message || e));
        if (e.detail) details.push(e.detail);
        if (e.kind === "invalid_key") throw e;
        if (e.kind === "quota") sawQuota = true;
        lastErr = e;
        if (e.kind === "server" && attempt === 0) {
          await sleep(env.__TEST_FAST ? 1 : 600);
          continue;
        }
        break; // sıradaki modele geç
      }
    }
  }
  const final = sawQuota ? new ProviderError("quota") : lastErr;
  final.detail = details.join(" | ");
  throw final;
}

async function translateDeepL(lines, env) {
  const host = String(env.DEEPL_KEY || "").endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
  const res = await fetch(`https://${host}/v2/translate`, {
    method: "POST",
    headers: { Authorization: `DeepL-Auth-Key ${env.DEEPL_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ text: lines, source_lang: "EN", target_lang: "TR", formality: "prefer_less" }),
  });
  if (res.status === 456 || res.status === 429) throw new ProviderError("quota");
  if (res.status === 403 || res.status === 401) throw new ProviderError("invalid_key");
  if (!res.ok) throw new ProviderError("server", String(res.status));
  const data = await res.json();
  return { out: data.translations.map((t) => t.text), provider: "deepl" };
}

async function translateAnthropic(lines, env) {
  const model = env.ANTHROPIC_MODEL || "claude-haiku-5-5";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1024, system: STYLE_PROMPT, messages: [{ role: "user", content: JSON.stringify(lines) }] }),
  });
  if (res.status === 429) throw new ProviderError("quota");
  if (res.status === 401 || res.status === 403) throw new ProviderError("invalid_key");
  if (res.status === 404 || res.status === 400) throw new ProviderError("model");
  if (!res.ok) throw new ProviderError("server", String(res.status));
  const data = await res.json();
  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return { out: parseJsonArray(text, lines.length), provider: model };
}

function serverProvider(env) {
  return (env.PROVIDER || "gemini").toLowerCase();
}

function serverKeyAvailable(env) {
  const p = serverProvider(env);
  if (p === "deepl") return !!env.DEEPL_KEY;
  if (p === "anthropic") return !!env.ANTHROPIC_KEY;
  return !!env.GEMINI_KEY;
}

async function translateWithServerKey(lines, env) {
  const p = serverProvider(env);
  if (p === "deepl") return translateDeepL(lines, env);
  if (p === "anthropic") return translateAnthropic(lines, env);
  return translateWithGeminiKey(lines, env.GEMINI_KEY, env);
}

// ---------------------------------------------------------------- üye API'si (TV uygulaması)

async function getMember(db, code) {
  if (!code) return null;
  return db.prepare("SELECT * FROM members WHERE code = ?").bind(String(code).toUpperCase().trim()).first();
}


/** Kodu ve cihazı doğrular; ilk girişte kodu cihaza kilitler. */
async function authMember(request, db) {
  const ip = clientIp(request);
  const wait = await lockedFor(db, "code", ip);
  if (wait) return { error: lockedResponse(wait) };
  const code = (request.headers.get("x-efex-code") || "").toUpperCase().trim();
  const device = (request.headers.get("x-efex-device") || "").trim().slice(0, 100);
  const member = await getMember(db, code);
  if (!member) {
    await recordFail(db, "code", ip);
    return { error: err("Kod geçersiz", 401) };
  }
  if (!member.active) return { error: err("Bu kod kapatılmış", 403) };
  if (!device) return { error: err("Cihaz kimliği eksik", 400) };
  if (member.device_id && member.device_id !== device) {
    return { error: err("Bu kod başka bir cihazda kullanılıyor", 403) };
  }
  if (!member.device_id) {
    await db.prepare("UPDATE members SET device_id = ? WHERE code = ?").bind(device, member.code).run();
    member.device_id = device;
  }
  return { member };
}

async function getUsage(db, code, day) {
  const row = await db.prepare("SELECT * FROM usage WHERE code = ? AND day = ?").bind(code, day).first();
  return row || { chars: 0, lines: 0, cached: 0, own_chars: 0, device_lines: 0 };
}

async function handleLogin(request, env) {
  const { member, error } = await authMember(request, env.DB);
  if (error) return error;
  await env.DB.prepare("UPDATE members SET last_seen = ? WHERE code = ?").bind(nowIso(), member.code).run();
  const usage = await getUsage(env.DB, member.code, today());
  return json({
    ok: true,
    name: member.name,
    dailyLimit: member.daily_limit,
    usedToday: usage.chars,
    version: VERSION,
  });
}

async function handleTranslate(request, env) {
  const db = env.DB;
  const { member, error } = await authMember(request, db);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Geçersiz istek");
  }
  const raw = Array.isArray(body?.lines) ? body.lines : [];
  if (raw.length === 0) return err("Çevrilecek satır yok");
  if (raw.length > MAX_LINES_PER_REQUEST) return err(`En fazla ${MAX_LINES_PER_REQUEST} satır gönderilebilir`);
  const lines = raw.map(normalizeLine);
  if (lines.some((l) => !l || l.length > MAX_LINE_LENGTH)) return err("Satır boş ya da çok uzun");

  const day = today();
  const hashes = await Promise.all(lines.map(sha256));
  const results = new Array(lines.length).fill(null);
  const fromCache = new Array(lines.length).fill(false);
  const missing = [];

  // 1) Ortak havuz
  for (let i = 0; i < lines.length; i++) {
    const row = await db.prepare("SELECT target FROM translations WHERE hash = ?").bind(hashes[i]).first();
    if (row) {
      results[i] = row.target;
      fromCache[i] = true;
    } else missing.push(i);
  }

  // Aynı istekte tekrar eden satırları bir kez çevir
  const uniqueMissing = [];
  const slot = new Map();
  for (const i of missing) {
    if (!slot.has(hashes[i])) {
      slot.set(hashes[i], uniqueMissing.length);
      uniqueMissing.push(i);
    }
  }
  const toTranslate = uniqueMissing.map((i) => lines[i]);
  const newChars = toTranslate.reduce((n, l) => n + l.length, 0);

  let translated = null; // { out, provider }
  let reason = null;

  if (toTranslate.length) {
    if (!serverKeyAvailable(env)) {
      reason = "no_key";
    } else {
      const usage = await getUsage(db, member.code, day);
      if (usage.chars + newChars > member.daily_limit) {
        reason = "daily_limit";
      } else {
        try {
          translated = await translateWithServerKey(toTranslate, env);
          await setStatus(db, "server_key", `ok|${translated.provider}`);
        } catch (e) {
          reason = e.kind || "server";
          await setStatus(db, "server_key", `${reason}|${serverProvider(env)}|${e.detail || ""}`);
        }
      }
    }

    if (translated) {
      await db.batch(
        uniqueMissing.map((i, k) =>
          db
            .prepare("INSERT OR IGNORE INTO translations (hash, source, target, provider, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(hashes[i], lines[i], translated.out[k], translated.provider, nowIso())
        )
      );
      for (const i of missing) results[i] = translated.out[slot.get(hashes[i])];
      reason = null;
    }
  }

  // Kayıtlar
  const cachedCount = fromCache.filter(Boolean).length;
  const deviceLines = results.filter((r) => r === null).length;
  const stmts = [];
  fromCache.forEach((c, i) => {
    if (c) stmts.push(db.prepare("UPDATE translations SET hits = hits + 1 WHERE hash = ?").bind(hashes[i]));
  });
  stmts.push(
    db
      .prepare(
        `INSERT INTO usage (code, day, chars, lines, cached, own_chars, device_lines) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code, day) DO UPDATE SET chars = chars + excluded.chars, lines = lines + excluded.lines,
           cached = cached + excluded.cached, own_chars = own_chars + excluded.own_chars,
           device_lines = device_lines + excluded.device_lines`
      )
      .bind(member.code, day, translated ? newChars : 0, lines.length, cachedCount, 0, deviceLines)
  );
  stmts.push(db.prepare("UPDATE members SET last_seen = ? WHERE code = ?").bind(nowIso(), member.code));
  await db.batch(stmts);

  const response = { ok: true, translations: results, cached: fromCache };
  if (deviceLines > 0) {
    // null olan satırlar çevrilemedi; TV orijinal İngilizceyi bırakır ve küçük bir uyarı gösterir.
    response.untranslated = true;
    response.reason = reason || "server";
    response.message = REASON_TEXT[response.reason] || REASON_TEXT.server;
  }
  return json(response);
}

// ---------------------------------------------------------------- dublaj (beta)

/** TV uygulamasıyla aynı liste: sesler, karakterin cinsiyetine ve ses kalınlığına göre gruplu */
export const VOICES = {
  man_low: ["Charon", "Algenib", "Orus", "Alnilam", "Rasalgethi"],
  man_mid: ["Iapetus", "Schedar", "Umbriel", "Achird", "Sadaltager"],
  man_high: ["Puck", "Fenrir", "Zubenelgenubi", "Sadachbia", "Enceladus"],
  woman_low: ["Gacrux", "Kore", "Vindemiatrix"],
  woman_mid: ["Aoede", "Despina", "Erinome", "Pulcherrima", "Sulafat"],
  woman_high: ["Leda", "Zephyr", "Laomedeia", "Achernar", "Autonoe", "Callirrhoe"],
};
const ALL_VOICES = new Set(Object.values(VOICES).flat());

// Ses modeline verilen yönlendirme. Google'ın belgelerindeki kısa kalıp kullanılır
// ("Say cheerfully: …"): iki noktadan önceki kısım yönlendirme, sonrası okunacak metin.
// Uzun talimatlar modele okutuluyordu (0.6.0 hatası).
const PERSONA_TEXT = {
  man_low: "as a mature man with a deep, gravelly voice",
  man_mid: "as an adult man with a medium-pitched voice",
  man_high: "as a young man with a lighter voice",
  woman_low: "as a mature woman with a low voice",
  woman_mid: "as an adult woman with a medium-pitched voice",
  woman_high: "as a young woman with a bright voice",
};
const STYLE_TEXT = {
  normal: "Say naturally and casually in Turkish",
  loud: "Shout tensely and loudly in Turkish",
  quiet: "Say quietly, almost whispering, in Turkish",
};
/** Havuz sürümü: değişince eski (hatalı) sesler kullanılmaz ve silinir */
const AUDIO_POOL_VERSION = "v2";
const TTS_RATE = 24000;
const MAX_AUDIO_BYTES = 1_900_000;

function ttsModels(env) {
  const list = [env.TTS_MODEL, "gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts", "gemini-2.5-flash-preview-tts"];
  return [...new Set(list.filter(Boolean))];
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** SSE akışından ses parçalarını çıkarır */
async function* sseAudioChunks(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      let evt;
      try {
        evt = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      for (const part of evt?.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData?.data) yield b64ToBytes(part.inlineData.data);
      }
    }
    if (done) break;
  }
}

/** Bir modelle seslendirmeyi başlatır; ilk ses parçası gelene kadar bekler (gelmezse sıradaki model) */
async function startTts(text, voice, persona, style, env) {
  const prompt = `${STYLE_TEXT[style]}, ${PERSONA_TEXT[persona]}: ${text}`;
  const details = [];
  let sawQuota = false;
  for (const model of ttsModels(env)) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        }),
      });
    } catch (e) {
      details.push(`${model}: ${e.message || e}`);
      continue;
    }
    if (!res.ok) {
      const e = await classifyGeminiError(res, model);
      details.push(e.detail);
      if (e.kind === "invalid_key") throw e;
      if (e.kind === "quota") sawQuota = true;
      continue;
    }
    const it = sseAudioChunks(res.body);
    const first = await it.next();
    if (first.done) {
      details.push(`${model}: ses gelmedi`);
      continue;
    }
    return { model, first: first.value, rest: it };
  }
  const err = new ProviderError(sawQuota ? "quota" : "model");
  err.detail = details.join(" | ");
  throw err;
}

async function handleSpeak(request, env, ctx) {
  const db = env.DB;
  const { member, error } = await authMember(request, db);
  if (error) return error;
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Geçersiz istek");
  }
  const text = normalizeLine(body?.text);
  const voice = String(body?.voice || "");
  const persona = String(body?.persona || "");
  const style = STYLE_TEXT[body?.style] ? body.style : "normal";
  if (!text || text.length > 300) return err("Metin boş ya da çok uzun");
  if (!ALL_VOICES.has(voice) || !PERSONA_TEXT[persona]) return err("Geçersiz ses");

  const day = today();
  const hash = await sha256(`${AUDIO_POOL_VERSION}|${voice}|${persona}|${style}|${text}`);
  const later = (p) => (ctx?.waitUntil ? ctx.waitUntil(p) : p);
  const countUsage = (chars, cached) =>
    db
      .prepare(
        `INSERT INTO usage (code, day, chars, tts_lines, tts_cached) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(code, day) DO UPDATE SET chars = chars + excluded.chars,
           tts_lines = tts_lines + 1, tts_cached = tts_cached + excluded.tts_cached`
      )
      .bind(member.code, day, chars, cached ? 1 : 0)
      .run();

  // 1) Ses havuzu: daha önce üretilmiş ses anında gelir
  const row = await db.prepare("SELECT pcm, rate FROM audio WHERE hash = ?").bind(hash).first();
  if (row) {
    await later(Promise.all([db.prepare("UPDATE audio SET hits = hits + 1 WHERE hash = ?").bind(hash).run(), countUsage(0, true)]));
    // D1, BLOB'u sürüme göre dizi ya da ArrayBuffer olarak döndürebilir
    const pcm = Array.isArray(row.pcm) ? Uint8Array.from(row.pcm) : new Uint8Array(row.pcm.buffer ? row.pcm.buffer.slice(row.pcm.byteOffset || 0, (row.pcm.byteOffset || 0) + row.pcm.byteLength) : row.pcm);
    return new Response(pcm, {
      headers: { "content-type": "application/octet-stream", "x-sample-rate": String(row.rate), "x-efex-cached": "1", "cache-control": "no-store" },
    });
  }

  // 2) Günlük hak (çeviriyle ortak)
  if (!env.GEMINI_KEY) return err("Dublaj için Gemini anahtarı gerekli", 503, { reason: "no_key" });
  const usage = await getUsage(db, member.code, day);
  if (usage.chars + text.length > member.daily_limit) return err("Günlük hak doldu", 429, { reason: "daily_limit" });

  // 3) Gemini ile seslendir, gelen parçaları anında TV'ye aktar
  let started;
  try {
    started = await startTts(text, voice, persona, style, env);
    await setStatus(db, "tts", `ok|${started.model}`);
  } catch (e) {
    await setStatus(db, "tts", `${e.kind || "server"}|gemini|${e.detail || ""}`);
    return err("Dublaj şu an yapılamıyor", 502, { reason: e.kind || "server" });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const pump = (async () => {
    const parts = [started.first];
    let total = started.first.length;
    let complete = false;
    try {
      await writer.write(started.first);
      for await (const chunk of started.rest) {
        parts.push(chunk);
        total += chunk.length;
        await writer.write(chunk);
      }
      complete = true;
    } catch (e) {
      console.error("tts stream", e);
    } finally {
      try { await writer.close(); } catch {}
    }
    await countUsage(text.length, false);
    // Güvenlik: ses, metne göre beklenenden çok uzunsa (model yönlendirmeyi de okuduysa) havuza girmez
    const seconds = total / (TTS_RATE * 2);
    const expectedMax = 2 + text.length * 0.12;
    const plausible = seconds <= expectedMax;
    if (!plausible) await setStatus(db, "tts", `bad_output|gemini|${started.model}: ${seconds.toFixed(1)} sn ses, ${text.length} karakterlik metin için fazla uzun`);
    if (complete && plausible && total > 1000 && total <= MAX_AUDIO_BYTES) {
      const pcm = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { pcm.set(p, off); off += p.length; }
      await db
        .prepare("INSERT OR IGNORE INTO audio (hash, text, voice, style, rate, pcm, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(hash, text, voice, `${persona}/${style}/${AUDIO_POOL_VERSION}`, TTS_RATE, pcm.buffer, started.model, nowIso())
        .run();
    }
  })();
  later(pump);
  return new Response(readable, {
    headers: { "content-type": "application/octet-stream", "x-sample-rate": String(TTS_RATE), "x-efex-cached": "0", "cache-control": "no-store" },
  });
}

// ---------------------------------------------------------------- yönetim API'si

function isAdmin(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return env.ADMIN_PASSWORD && safeEqual(token, env.ADMIN_PASSWORD);
}

async function handleAdminApi(request, env, path) {
  const ip = clientIp(request);
  const wait = await lockedFor(env.DB, "admin", ip);
  if (wait) return lockedResponse(wait);
  if (!isAdmin(request, env)) {
    await recordFail(env.DB, "admin", ip);
    return err("Yetkisiz", 401);
  }
  await clearFails(env.DB, "admin", ip);
  const db = env.DB;
  const day = today();
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

  if (path === "/admin/api/overview") {
    const members = await db
      .prepare(
        `SELECT m.code, m.name, m.active, m.daily_limit, m.device_id IS NOT NULL AS locked,
                m.created_at, m.last_seen, m.has_own_key, m.key_state, m.key_state_at,
                COALESCE(u.chars, 0) AS used_today, COALESCE(u.lines, 0) AS lines_today,
                COALESCE(u.own_chars, 0) AS own_today, COALESCE(u.device_lines, 0) AS device_today,
                COALESCE(u.tts_lines, 0) AS tts_today
         FROM members m LEFT JOIN usage u ON u.code = m.code AND u.day = ?
         ORDER BY m.created_at DESC`
      )
      .bind(day)
      .all();
    const pool = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(hits), 0) AS hits FROM translations").first();
    const todayTotals = await db
      .prepare(
        "SELECT COALESCE(SUM(chars),0) AS chars, COALESCE(SUM(own_chars),0) AS own_chars, COALESCE(SUM(lines),0) AS lines, COALESCE(SUM(cached),0) AS cached, COALESCE(SUM(device_lines),0) AS device_lines, COALESCE(SUM(tts_lines),0) AS tts_lines, COALESCE(SUM(tts_cached),0) AS tts_cached FROM usage WHERE day = ?"
      )
      .bind(day)
      .first();
    const serverStatus = await db.prepare("SELECT value, updated_at FROM status WHERE name = 'server_key'").first();
    const ttsStatus = await db.prepare("SELECT value, updated_at FROM status WHERE name = 'tts'").first();
    const audioPool = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(hits), 0) AS hits, COALESCE(SUM(LENGTH(pcm)), 0) AS bytes FROM audio").first();
    return json({
      ok: true,
      version: VERSION,
      day,
      models: geminiModels(env),
      keyConfigured: serverKeyAvailable(env),
      weakPassword: String(env.ADMIN_PASSWORD || "").length < 12,
      hiddenPath: !!env.ADMIN_PATH,
      serverProvider: serverProvider(env),
      serverStatus,
      ttsStatus,
      ttsModels: ttsModels(env),
      audioPool,
      members: members.results,
      pool,
      today: todayTotals,
    });
  }

  if (path === "/admin/api/members/create") {
    const name = String(body.name || "").trim().slice(0, 40);
    if (!name) return err("İsim gerekli");
    const limit = Math.max(1000, parseInt(body.dailyLimit, 10) || parseInt(env.DEFAULT_DAILY_LIMIT, 10) || 60000);
    let code = newCode();
    for (let i = 0; i < 3 && (await getMember(db, code)); i++) code = newCode();
    await db
      .prepare("INSERT INTO members (code, name, active, daily_limit, created_at) VALUES (?, ?, 1, ?, ?)")
      .bind(code, name, limit, nowIso())
      .run();
    return json({ ok: true, code });
  }

  const code = String(body.code || "").toUpperCase().trim();
  if (path.startsWith("/admin/api/members/") && !(await getMember(db, code))) return err("Üye bulunamadı", 404);

  if (path === "/admin/api/members/toggle") {
    await db.prepare("UPDATE members SET active = 1 - active WHERE code = ?").bind(code).run();
    return json({ ok: true });
  }
  if (path === "/admin/api/members/reset-device") {
    await db.prepare("UPDATE members SET device_id = NULL WHERE code = ?").bind(code).run();
    return json({ ok: true });
  }
  if (path === "/admin/api/members/limit") {
    const limit = Math.max(1000, parseInt(body.dailyLimit, 10) || 0);
    await db.prepare("UPDATE members SET daily_limit = ? WHERE code = ?").bind(limit, code).run();
    return json({ ok: true });
  }
  if (path === "/admin/api/members/delete") {
    await db.batch([
      db.prepare("DELETE FROM usage WHERE code = ?").bind(code),
      db.prepare("DELETE FROM members WHERE code = ?").bind(code),
    ]);
    return json({ ok: true });
  }

  if (path === "/admin/api/pool/search") {
    const q = `%${String(body.q || "").trim()}%`;
    const rows = await db
      .prepare(
        "SELECT hash, source, target, provider, edited, hits FROM translations WHERE source LIKE ? OR target LIKE ? ORDER BY created_at DESC LIMIT 50"
      )
      .bind(q, q)
      .all();
    return json({ ok: true, rows: rows.results });
  }
  if (path === "/admin/api/pool/edit") {
    const target = String(body.target || "").trim();
    if (!body.hash || !target) return err("Eksik bilgi");
    await db.prepare("UPDATE translations SET target = ?, edited = 1 WHERE hash = ?").bind(target, String(body.hash)).run();
    return json({ ok: true });
  }
  if (path === "/admin/api/pool/delete") {
    await db.prepare("DELETE FROM translations WHERE hash = ?").bind(String(body.hash || "")).run();
    return json({ ok: true });
  }

  return err("Bilinmeyen işlem", 404);
}
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Efex Sub · Yönetim</title>
<style>
  :root{--bg:#0b0d10;--card:#151920;--line:#252b35;--text:#e8ecf1;--dim:#8b95a3;--accent:#ffb020;--ok:#3ecf8e;--bad:#ff5c5c}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px 16px 60px;max-width:720px;margin:auto}
  h1{font-size:22px;margin:4px 0 2px;letter-spacing:.3px}
  h1 span{color:var(--accent)}
  h2{font-size:15px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.8px;margin:26px 0 10px}
  .sub{color:var(--dim);font-size:13px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:10px}
  .stats{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
  .warn{border-color:#5a4313;background:#1d180c}
  .warn b{color:var(--accent)}
  .keyline{font-size:13px;margin-top:4px}
  .k-ok{color:var(--ok)} .k-bad{color:var(--bad)} .k-mid{color:var(--accent)} .k-none{color:var(--dim)}
  .stat b{display:block;font-size:20px}
  .stat span{color:var(--dim);font-size:12px}
  input,button{font:inherit;border-radius:10px;border:1px solid var(--line);background:#0f1217;color:var(--text);padding:11px 12px}
  input{width:100%}
  button{background:var(--accent);color:#111;border:none;font-weight:700;cursor:pointer}
  button.ghost{background:transparent;color:var(--text);border:1px solid var(--line);font-weight:500}
  button.danger{background:transparent;color:var(--bad);border:1px solid #4a2326;font-weight:500}
  .row{display:flex;gap:8px;align-items:center}
  .row>*{flex:1}
  .row>button{flex:0 0 auto}
  .member .top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .code{font-family:ui-monospace,Menlo,monospace;font-size:14px;color:var(--accent);user-select:all}
  .pill{font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
  .pill.on{color:var(--ok);border-color:#1f4d3b}
  .pill.off{color:var(--bad);border-color:#4a2326}
  .bar{height:6px;border-radius:6px;background:#0f1217;overflow:hidden;margin:10px 0 6px}
  .bar i{display:block;height:100%;background:var(--accent)}
  .actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  .actions button{padding:8px 10px;font-size:13px}
  .pool .src{color:var(--dim);font-size:13px}
  .pool textarea{width:100%;margin-top:6px;font:inherit;background:#0f1217;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:8px}
  #toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#222833;padding:10px 16px;border-radius:10px;display:none}
  .hidden{display:none}
</style>
</head>
<body>
<h1>Efex <span>Sub</span></h1>
<div class="sub" id="meta">Yönetim paneli</div>

<div id="login" class="card" style="margin-top:18px">
  <div class="sub" style="margin-bottom:8px">Yönetici şifresi</div>
  <div class="row"><input id="pw" type="password" autocomplete="current-password"><button onclick="login()">Giriş</button></div>
</div>

<div id="app" class="hidden">
  <div id="warnings"></div>
  <h2>Bugün</h2>
  <div class="card stats">
    <div class="stat"><b id="sLines">0</b><span>altyazı satırı</span></div>
    <div class="stat"><b id="sCached">0</b><span>havuzdan bedava geldi</span></div>
    <div class="stat"><b id="sDevice">0</b><span>çevrilemedi (İngilizce kaldı)</span></div>
    <div class="stat"><b id="sChars">0</b><span>çevrilen karakter (ücretli)</span></div>
    <div class="stat"><b id="sTts">0</b><span>dublaj satırı (beta)</span></div>
    <div class="stat"><b id="sTtsCached">0</b><span>dublaj havuzdan geldi</span></div>
  </div>
  <div class="card sub" id="engine"></div>

  <h2>Yeni arkadaş kodu</h2>
  <div class="card">
    <div class="row" style="margin-bottom:8px"><input id="newName" placeholder="İsim (ör. Ahmet)"></div>
    <div class="row"><input id="newLimit" type="number" inputmode="numeric" placeholder="Günlük hak, karakter (boş: 60000)"><button onclick="createMember()">Oluştur</button></div>
  </div>

  <h2>Arkadaşlar</h2>
  <div id="members"></div>

  <h2>Çeviri havuzu</h2>
  <div class="card">
    <div class="row"><input id="q" placeholder="Cümle ara (İngilizce ya da Türkçe)"><button class="ghost" onclick="searchPool()">Ara</button></div>
  </div>
  <div id="pool" class="pool"></div>
</div>

<div id="toast"></div>

<script>
let PW = ""; try { PW = sessionStorage.getItem("efexpw") || ""; } catch (e) {}
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = (n) => Number(n || 0).toLocaleString("tr-TR");

function toast(msg){const t=$("toast");t.textContent=msg;t.style.display="block";clearTimeout(t._h);t._h=setTimeout(()=>t.style.display="none",2200)}

async function api(path, body){
  const base = location.pathname.replace(/[/]+$/, "");
  const res = await fetch(base + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: {"authorization": "Bearer " + PW, "content-type": "application/json"},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({ok:false,error:"Sunucu yanıtı okunamadı"}));
  if (res.status === 401) { try{sessionStorage.removeItem("efexpw")}catch(e){} show(false); throw new Error("Şifre yanlış"); }
  if (res.status === 429) { try{sessionStorage.removeItem("efexpw")}catch(e){} show(false); throw new Error(data.error || "Çok fazla hatalı deneme"); }
  if (!data.ok) throw new Error(data.error || "Hata");
  return data;
}

function show(loggedIn){ $("login").classList.toggle("hidden", loggedIn); $("app").classList.toggle("hidden", !loggedIn); }

async function login(){
  PW = $("pw").value;
  try { await load(); try{sessionStorage.setItem("efexpw", PW)}catch(e){} } catch(e){ toast(e.message) }
}

async function load(){
  const d = await api("overview");
  show(true);
  $("meta").textContent = "Sürüm " + d.version + " · " + d.day + " · havuzda " + fmt(d.pool.n) + " çeviri";
  $("sLines").textContent = fmt(d.today.lines);
  $("sCached").textContent = fmt(d.today.cached);
  $("sDevice").textContent = fmt(d.today.device_lines);
  $("sChars").textContent = fmt(d.today.chars);
  $("sTts").textContent = fmt(d.today.tts_lines);
  $("sTtsCached").textContent = fmt(d.today.tts_cached);
  $("engine").innerHTML = "Modeller: <b>" + esc(d.models.join(" → ")) + "</b><br>Gemini anahtarı: " +
    (d.keyConfigured ? '<span class="k-ok">tanımlı</span>' : '<span class="k-bad">tanımlı değil — Cloudflare ayarlarına GEMINI_KEY ekle</span>') +
    "<br>Dublaj (beta) modelleri: <b>" + esc(d.ttsModels.join(" → ")) + "</b>" +
    "<br>Ses havuzu: " + fmt(d.audioPool.n) + " replik · " + (d.audioPool.bytes / 1048576).toFixed(1) + " MB";
  const w = [];
  if (d.serverStatus && !String(d.serverStatus.value).startsWith("ok")) {
    const parts = String(d.serverStatus.value).split("|");
    const kind = parts[0], detail = parts.slice(2).join("|");
    w.push("<b>Gemini anahtarı:</b> " + esc(REASONS[kind] || kind) + " (" + esc(ago(d.serverStatus.updated_at)) + ")" +
      (detail ? '<div class="sub" style="margin-top:6px;word-break:break-word">Google mesajı: ' + esc(detail) + '</div>' : ""));
  }
  if (d.ttsStatus && !String(d.ttsStatus.value).startsWith("ok")) {
    const tp = String(d.ttsStatus.value).split("|");
    const td = tp.slice(2).join("|");
    w.push("<b>Dublaj (beta):</b> " + esc(REASONS[tp[0]] || tp[0]) + " (" + esc(ago(d.ttsStatus.updated_at)) + ")" +
      (td ? '<div class="sub" style="margin-top:6px;word-break:break-word">Google mesajı: ' + esc(td) + '</div>' : "") +
      '<div class="sub">Model adı değiştiyse Cloudflare ayarlarına TTS_MODEL değişkeni ekle.</div>');
  }
  if (d.weakPassword) w.push("<b>Panel şifren kısa:</b> Cloudflare'de ADMIN_PASSWORD'ü en az 12 karakterlik bir şifreyle değiştir.");
  if (!d.hiddenPath) w.push("<b>Panel adresi tahmin edilebilir:</b> Cloudflare'e ADMIN_PATH değişkeni ekleyip paneli gizli bir adrese taşı.");
  const full = d.members.filter((m) => m.used_today >= m.daily_limit * 0.95);
  if (full.length) w.push("<b>Günlük hakkı dolanlar:</b> " + full.map((m) => esc(m.name)).join(", "));
  $("warnings").innerHTML = w.length ? '<h2>Uyarılar</h2><div class="card warn">' + w.join("<br>") + '<div class="sub" style="margin-top:6px">Bu sırada yeni cümleler çevrilmez, İngilizce altyazı görünür. Havuzdaki cümleler gelmeye devam eder.</div></div>' : "";
  $("members").innerHTML = d.members.length ? d.members.map(memberCard).join("") : '<div class="card sub">Henüz kod yok. Yukarıdan ilk kodu oluştur.</div>';
}

const REASONS = {quota:"Google sınırı doldu (faturalandırma açık mı?)", invalid_key:"anahtar geçersiz", server:"servis yanıt vermedi", model:"model bulunamadı (GEMINI_MODEL'i güncelle)", bad_output:"bozuk yanıt", daily_limit:"günlük hak doldu", no_key:"anahtar tanımlı değil"};
function ago(iso){ if(!iso) return ""; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? "az önce" : m < 60 ? m + " dk önce" : Math.round(m/60) + " saat önce"; }

function memberCard(m){
  const pct = Math.min(100, Math.round((m.used_today / m.daily_limit) * 100));
  const seen = m.last_seen ? new Date(m.last_seen).toLocaleString("tr-TR") : "hiç girmedi";
  return '<div class="card member">' +
    '<div class="top"><b>' + esc(m.name) + '</b>' +
      '<span class="pill ' + (m.active ? 'on">açık' : 'off">kapalı') + '</span></div>' +
    '<div class="code" onclick="copy(\\'' + m.code + '\\')">' + m.code + '</div>' +
    '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
    '<div class="sub">Bugün ' + fmt(m.used_today) + ' / ' + fmt(m.daily_limit) + ' karakter · ' + (m.locked ? 'cihaza kilitli' : 'cihaz bekleniyor') + ' · son giriş: ' + esc(seen) + (m.device_today ? ' · çevrilemeyen: ' + fmt(m.device_today) + ' satır' : '') + '</div>' +
    '<div class="actions">' +
      '<button class="ghost" onclick="act(\\'toggle\\',\\'' + m.code + '\\')">' + (m.active ? 'Kapat' : 'Aç') + '</button>' +
      '<button class="ghost" onclick="act(\\'reset-device\\',\\'' + m.code + '\\')">Cihazı sıfırla</button>' +
      '<button class="ghost" onclick="setLimit(\\'' + m.code + '\\',' + m.daily_limit + ')">Sınırı değiştir</button>' +
      '<button class="danger" onclick="del(\\'' + m.code + '\\',\\'' + esc(m.name).replace(/'/g, "") + '\\')">Sil</button>' +
    '</div></div>';
}

async function copy(code){ try{ await navigator.clipboard.writeText(code); toast("Kod kopyalandı") }catch(e){ toast(code) } }

async function createMember(){
  try {
    const d = await api("members/create", {name: $("newName").value, dailyLimit: $("newLimit").value});
    $("newName").value = ""; $("newLimit").value = "";
    await load(); copy(d.code);
  } catch(e){ toast(e.message) }
}

async function act(kind, code){ try { await api("members/" + kind, {code}); await load(); toast("Tamam") } catch(e){ toast(e.message) } }

async function setLimit(code, cur){
  const v = prompt("Yeni günlük sınır (karakter):", cur);
  if (!v) return;
  try { await api("members/limit", {code, dailyLimit: v}); await load(); toast("Sınır güncellendi") } catch(e){ toast(e.message) }
}

async function del(code, name){
  if (!confirm(name + " silinsin mi? Bu kod bir daha çalışmaz.")) return;
  act("delete", code);
}

async function searchPool(){
  try {
    const d = await api("pool/search", {q: $("q").value});
    $("pool").innerHTML = d.rows.length ? d.rows.map((r) =>
      '<div class="card"><div class="src">' + esc(r.source) + '</div>' +
      '<textarea rows="2" id="t_' + r.hash + '">' + esc(r.target) + '</textarea>' +
      '<div class="actions"><button class="ghost" onclick="savePool(\\'' + r.hash + '\\')">Kaydet</button>' +
      '<button class="danger" onclick="delPool(\\'' + r.hash + '\\')">Sil</button>' +
      '<span class="sub">' + r.hits + ' kez kullanıldı' + (r.edited ? ' · elle düzeltildi' : '') + '</span></div></div>'
    ).join("") : '<div class="card sub">Sonuç yok.</div>';
  } catch(e){ toast(e.message) }
}

async function savePool(hash){ try { await api("pool/edit", {hash, target: $("t_" + hash).value}); toast("Çeviri düzeltildi") } catch(e){ toast(e.message) } }
async function delPool(hash){ try { await api("pool/delete", {hash}); searchPool(); toast("Silindi, bir dahakine yeniden çevrilecek") } catch(e){ toast(e.message) } }

$("pw").addEventListener("keydown", (e) => { if (e.key === "Enter") login() });
if (PW) load().catch(() => show(false));
</script>
</body>
</html>`;

// ---------------------------------------------------------------- giriş noktası

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (!env.DB) return err("Sunucu kurulumu eksik: D1 veritabanı (DB) bağlanmamış", 500);
    await ensureSchema(env.DB);

    // Panel adresi: ADMIN_PATH yazılırsa gizli adres, yoksa /admin
    const adminBase = "/" + String(env.ADMIN_PATH || "admin").replace(/^\/+|\/+$/g, "");

    try {
      if (path === "/" || path === "/api/ping") return json({ ok: true, service: "Efex Sub", version: VERSION });
      if (path === "/indir" || path === "/apk") {
        return Response.redirect(env.APK_URL || "https://github.com/efex001/efex-sub/releases/latest/download/efex-sub.apk", 302);
      }
      if (path === adminBase && request.method === "GET") {
        return new Response(ADMIN_HTML, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-frame-options": "DENY",
            "referrer-policy": "no-referrer",
            "x-robots-tag": "noindex, nofollow",
            "x-content-type-options": "nosniff",
            "content-security-policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          },
        });
      }
      if (path.startsWith(adminBase + "/api/")) return await handleAdminApi(request, env, "/admin/api/" + path.slice(adminBase.length + 5));
      if (path === "/api/login" && request.method === "POST") return await handleLogin(request, env);
      if (path === "/api/translate" && request.method === "POST") return await handleTranslate(request, env);
      if (path === "/api/speak" && request.method === "POST") return await handleSpeak(request, env, ctx);
      return err("Bulunamadı", 404);
    } catch (e) {
      console.error(e);
      return err("Sunucu hatası", 500);
    }
  },
};
