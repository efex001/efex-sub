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
 *
 * Güvenlik: yanlış panel şifresi IP başına 5 denemede 30 dk, geçersiz arkadaş kodu
 * IP başına 10 denemede 30 dk kilitlenir.
 */

const VERSION = "0.5.0";
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
  ];
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
                COALESCE(u.own_chars, 0) AS own_today, COALESCE(u.device_lines, 0) AS device_today
         FROM members m LEFT JOIN usage u ON u.code = m.code AND u.day = ?
         ORDER BY m.created_at DESC`
      )
      .bind(day)
      .all();
    const pool = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(hits), 0) AS hits FROM translations").first();
    const todayTotals = await db
      .prepare(
        "SELECT COALESCE(SUM(chars),0) AS chars, COALESCE(SUM(own_chars),0) AS own_chars, COALESCE(SUM(lines),0) AS lines, COALESCE(SUM(cached),0) AS cached, COALESCE(SUM(device_lines),0) AS device_lines FROM usage WHERE day = ?"
      )
      .bind(day)
      .first();
    const serverStatus = await db.prepare("SELECT value, updated_at FROM status WHERE name = 'server_key'").first();
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
