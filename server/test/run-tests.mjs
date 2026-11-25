// Efex Sub sunucusu için yerel testler: D1'i node:sqlite ile, Gemini'yi sahte fetch ile taklit eder.
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import worker from "../worker.js";

// ---- D1 taklidi
function makeD1() {
  const sql = new DatabaseSync(":memory:");
  // D1 gibi: ArrayBuffer'ı BLOB olarak kabul eder, BLOB'u sayı dizisi olarak döndürür
  const toSql = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
  const fromSql = (row) => {
    if (!row) return row;
    for (const k of Object.keys(row)) if (row[k] instanceof Uint8Array) row[k] = Array.from(row[k]);
    return row;
  };
  const wrap = (query, params = []) => ({
    bind: (...p) => wrap(query, p.map(toSql)),
    async first() { return fromSql(sql.prepare(query).get(...params)) ?? null; },
    async all() { return { results: sql.prepare(query).all(...params) }; },
    async run() { sql.prepare(query).run(...params); return { success: true }; },
    _exec() { sql.prepare(query).run(...params); },
  });
  return {
    _sql: sql,
    prepare: (q) => wrap(q),
    async batch(stmts) { sql.exec("BEGIN"); try { stmts.forEach((s) => s._exec()); sql.exec("COMMIT"); } catch (e) { sql.exec("ROLLBACK"); throw e; } },
  };
}

// ---- sahte Gemini: anahtar ve modele göre davranış
// keyBehavior[key] = "ok" | "quota" | "invalid" | "server" | { [model]: davranış }
const keyBehavior = {};
const calls = [];
// ---- sahte Gemini TTS: modele göre davranış ("ok" | "notfound" | "quota" | "empty")
const ttsBehavior = {};
const ttsCalls = [];
function sse(events) {
  const text = events.map((e) => "data: " + JSON.stringify(e) + "\r\n\r\n").join("");
  return new Response(new ReadableStream({ start(c) { const b = new TextEncoder().encode(text); c.enqueue(b.slice(0, 7)); c.enqueue(b.slice(7)); c.close(); } }), { status: 200 });
}
const pcmB64 = (n, v) => Buffer.from(new Uint8Array(n).fill(v)).toString("base64");

globalThis.fetch = async (url, init) => {
  const u = String(url);
  assert.ok(u.includes("generativelanguage.googleapis.com"), "beklenmeyen adres: " + u);
  if (u.includes(":streamGenerateContent")) {
    const model = decodeURIComponent(u.match(/models\/([^:]+):/)[1]);
    const body = JSON.parse(init.body);
    ttsCalls.push({ model, voice: body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, prompt: body.contents[0].parts[0].text });
    const b = ttsBehavior[model] ?? "notfound";
    if (b === "notfound") return new Response('{"error":{"code":404,"message":"model not found"}}', { status: 404 });
    if (b === "quota") return new Response('{"error":{"code":429}}', { status: 429 });
    if (b === "empty") return sse([{ candidates: [{ content: { parts: [{ text: "x" }] } }] }]);
    return sse([
      { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcmB64(3000, 1) } }] } }] },
      { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcmB64(2000, 2) } }] } }] },
    ]);
  }
  const model = decodeURIComponent(u.match(/models\/([^:]+):/)[1]);
  const key = init.headers["x-goog-api-key"];
  const body = JSON.parse(init.body);
  const isGemma = model.startsWith("gemma");
  if (isGemma) {
    assert.equal(body.systemInstruction, undefined, "Gemma'ya sistem talimatı gitmemeli");
    assert.equal(body.generationConfig.responseMimeType, undefined, "Gemma'ya JSON modu gitmemeli");
  }
  const text = body.contents[0].parts[0].text;
  const lines = JSON.parse(isGemma ? text.slice(text.indexOf("Satırlar:\n") + 10) : text);
  calls.push({ key, model, lines });
  let b = keyBehavior[key] ?? "invalid";
  if (typeof b === "object") b = b[model] ?? "ok";
  if (b === "quota") return new Response('{"error":{"code":429}}', { status: 429 });
  if (b === "invalid") return new Response('{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}', { status: 400 });
  if (b === "server") return new Response("down", { status: 503 });
  if (b === "notfound") return new Response('{"error":{"code":404}}', { status: 404 });
  const out = lines.map((l) => `TR(${model}):${l}`);
  const payload = isGemma ? "```json\n" + JSON.stringify(out) + "\n```" : JSON.stringify(out);
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: payload }] } }] }), { status: 200 });
};

const env = { DB: makeD1(), ADMIN_PASSWORD: "gizli-sifre", GEMINI_KEY: "SERVER-KEY-xxxxxxxxxxxxxxxx", __TEST_FAST: true };
keyBehavior[env.GEMINI_KEY] = "ok";
const FRIEND_KEY = "FRIEND-KEY-aaaaaaaaaaaaaaaa";

const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, { method = "POST", body, headers = {} } = {}) => {
  const res = await worker.fetch(new Request("https://efex.test" + path, {
    method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
  if ((res.headers.get("content-type") || "").includes("octet-stream")) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    await settle();
    return { status: res.status, bytes, headers: res.headers };
  }
  const ct = res.headers.get("content-type") || "";
  return { status: res.status, data: ct.includes("json") ? await res.json() : await res.text() };
};
const admin = (p, body) => call("/admin/api/" + p, { method: body ? "POST" : "GET", body, headers: { authorization: "Bearer gizli-sifre" } });
const member = (p, body, code, { device = "tv-1", key } = {}) =>
  call(p, { body, headers: { "x-efex-code": code, "x-efex-device": device, ...(key ? { "x-efex-gemini-key": key } : {}) } });

let passed = 0;
const t = async (name, fn) => { calls.length = 0; await fn(); passed++; console.log("✓", name); };

// ---------------------------------------------------------------- temel
await t("ping çalışıyor", async () => {
  assert.equal((await call("/api/ping", { method: "GET" })).data.version, "0.6.0");
});

await t("panel sayfası geliyor ve içindeki JS hatasız", async () => {
  const r = await call("/admin", { method: "GET" });
  assert.equal(r.status, 200);
  new Function(r.data.match(/<script>([\s\S]*)<\/script>/)[1]);
});

await t("yanlış şifreyle yönetim reddedilir", async () => {
  assert.equal((await call("/admin/api/overview", { method: "GET", headers: { authorization: "Bearer yanlis" } })).status, 401);
});

let code, code2;
await t("arkadaş kodları oluşturulur", async () => {
  code = (await admin("members/create", { name: "Ahmet", dailyLimit: 1000 })).data.code;
  code2 = (await admin("members/create", { name: "Mehmet", dailyLimit: 1000 })).data.code;
  assert.match(code, /^EFEX-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

await t("geçersiz kod reddedilir, kod ilk cihaza kilitlenir", async () => {
  assert.equal((await member("/api/login", {}, "EFEX-YOK0-YOK0")).status, 401);
  assert.equal((await member("/api/login", {}, code, { device: "tv-1" })).data.ok, true);
  assert.equal((await member("/api/login", {}, code, { device: "baska-tv" })).status, 403);
});

// ---------------------------------------------------------------- çeviri (senin anahtarın)
await t("çeviri senin anahtarınla yapılır ve günlük hakka yazılır", async () => {
  const r = await member("/api/translate", { lines: ["Get in the car!"] }, code);
  assert.deepEqual(r.data.translations, ["TR(gemini-3.5-flash-lite):Get in the car!"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, env.GEMINI_KEY);
  const m = (await admin("overview")).data.members.find((x) => x.code === code);
  assert.equal(m.used_today, "Get in the car!".length);
});

await t("TV'den gelen anahtar başlığı yok sayılır", async () => {
  const r = await member("/api/translate", { lines: ["Ignore friend key"] }, code, { key: FRIEND_KEY });
  assert.equal(calls[0].key, env.GEMINI_KEY);
  assert.equal(r.data.translations[0], "TR(gemini-3.5-flash-lite):Ignore friend key");
});

await t("havuzdaki cümle hiç servise gitmez ve haktan düşmez", async () => {
  const before = (await admin("overview")).data.members.find((x) => x.code === code2).used_today;
  const r = await member("/api/translate", { lines: ["get in the  car!"] }, code2, { device: "tv-2" });
  assert.equal(calls.length, 0);
  assert.deepEqual(r.data.cached, [true]);
  assert.equal(r.data.untranslated, undefined);
  const after = (await admin("overview")).data.members.find((x) => x.code === code2).used_today;
  assert.equal(after, before);
});

await t("ana model sınırda → yedek modele geçer", async () => {
  keyBehavior[env.GEMINI_KEY] = { "gemini-3.5-flash-lite": "quota" };
  const r = await member("/api/translate", { lines: ["Hands up!"] }, code);
  assert.deepEqual(r.data.translations, ["TR(gemini-3.1-flash-lite):Hands up!"]);
  assert.deepEqual(calls.map((c) => c.model), ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
});

await t("ana model kaldırılmışsa (404) yedek modele geçer", async () => {
  keyBehavior[env.GEMINI_KEY] = { "gemini-3.5-flash-lite": "notfound" };
  const r = await member("/api/translate", { lines: ["Model gone"] }, code);
  assert.match(r.data.translations[0], /gemini-3.1-flash-lite/);
  keyBehavior[env.GEMINI_KEY] = "ok";
});

await t("anlık sunucu hatasında bir kez tekrar dener", async () => {
  let n = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, i) => (++n === 1 ? new Response("down", { status: 503 }) : orig(u, i));
  const r = await member("/api/translate", { lines: ["Retry me"] }, code);
  globalThis.fetch = orig;
  assert.ok(r.data.translations[0]);
  assert.equal(n, 2);
});

await t("günlük hak dolunca satır çevrilmeden döner (İngilizce kalır), panel uyarır", async () => {
  let last;
  for (let i = 0; i < 10; i++) {
    last = await member("/api/translate", { lines: ["y".repeat(300) + i] }, code2, { device: "tv-2" });
    if (last.data.untranslated) break;
  }
  assert.equal(last.status, 200);
  assert.equal(last.data.untranslated, true);
  assert.equal(last.data.reason, "daily_limit");
  assert.equal(last.data.translations[0], null);
});

await t("Google sınırı dolunca: havuzdakiler gelir, gerisi çevrilmeden döner, panelde uyarı", async () => {
  keyBehavior[env.GEMINI_KEY] = "quota";
  const r = await member("/api/translate", { lines: ["Get in the car!", "Brand new line"] }, code);
  assert.equal(r.data.translations[0], "TR(gemini-3.5-flash-lite):Get in the car!");
  assert.equal(r.data.translations[1], null);
  assert.equal(r.data.reason, "quota");
  const o = await admin("overview");
  assert.ok(o.data.serverStatus.value.startsWith("quota"));
  assert.ok(o.data.today.device_lines >= 2);
  keyBehavior[env.GEMINI_KEY] = "ok";
});

await t("geçersiz anahtar yedek modeli denemeden durur", async () => {
  keyBehavior[env.GEMINI_KEY] = "invalid";
  const r = await member("/api/translate", { lines: ["Invalid key line"] }, code);
  assert.equal(calls.length, 1);
  assert.equal(r.data.reason, "invalid_key");
  keyBehavior[env.GEMINI_KEY] = "ok";
});

await t("AQ. anahtar hatası (401 ACCESS_TOKEN_TYPE_UNSUPPORTED) 'anahtar geçersiz' olarak görünür, Google mesajı panele düşer", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED", details: [{ reason: "ACCESS_TOKEN_TYPE_UNSUPPORTED" }] } }), { status: 401 });
  const r = await member("/api/translate", { lines: ["AQ key line"] }, code);
  globalThis.fetch = orig;
  assert.equal(r.data.reason, "invalid_key");
  const st = (await admin("overview")).data.serverStatus.value;
  assert.match(st, /ACCESS_TOKEN_TYPE_UNSUPPORTED/);
  assert.match(st, /gemini-3.5-flash-lite: HTTP 401/);
});

await t("model hatalarında iki modelin de mesajı kaydedilir", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => new Response(JSON.stringify({ error: { code: 404, message: "models/x is not found", status: "NOT_FOUND" } }), { status: 404 });
  const r = await member("/api/translate", { lines: ["Both models gone"] }, code);
  globalThis.fetch = orig;
  assert.equal(r.data.reason, "model");
  const st = (await admin("overview")).data.serverStatus.value;
  assert.match(st, /gemini-3.5-flash-lite: HTTP 404/);
  assert.match(st, /gemini-3.1-flash-lite: HTTP 404/);
});

await t("anahtar tanımlı değilse anlaşılır neden döner", async () => {
  const k = env.GEMINI_KEY; delete env.GEMINI_KEY;
  const r = await member("/api/translate", { lines: ["No server key"] }, code);
  assert.equal(r.data.reason, "no_key");
  assert.equal((await admin("overview")).data.keyConfigured, false);
  env.GEMINI_KEY = k;
});

await t("aynı istekte tekrar eden satır bir kez çevrilir", async () => {
  const r = await member("/api/translate", { lines: ["Run!", "Run!"] }, code);
  assert.deepEqual(calls[0].lines, ["Run!"]);
  assert.equal(r.data.translations[0], r.data.translations[1]);
});

await t("varsayılan günlük hak 60000", async () => {
  const c = (await admin("members/create", { name: "Varsayılan" })).data.code;
  const m = (await admin("overview")).data.members.find((x) => x.code === c);
  assert.equal(m.daily_limit, 60000);
  await admin("members/delete", { code: c });
});

// ---------------------------------------------------------------- dublaj (beta)
await t("dublaj: ilk model yoksa sıradakiyle akışlı ses gelir, havuza girer", async () => {
  ttsBehavior["gemini-3.8-flash-tts"] = "ok";
  ttsCalls.length = 0;
  const r = await member("/api/speak", { text: "Arabaya bin!", voice: "Charon", persona: "man_low", style: "loud" }, code);
  assert.equal(r.status, 200);
  assert.equal(r.bytes.length, 5000);
  assert.equal(r.headers.get("x-sample-rate"), "24000");
  assert.equal(r.headers.get("x-efex-cached"), "0");
  assert.deepEqual(ttsCalls.map((c) => c.model), ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"]);
  assert.equal(ttsCalls[1].voice, "Charon");
  assert.match(ttsCalls[1].prompt, /bağırır gibi/);
  assert.match(ttsCalls[1].prompt, /Arabaya bin!/);
});

await t("dublaj: aynı replik ikinci kez havuzdan anında gelir, Google'a gitmez", async () => {
  ttsCalls.length = 0;
  const r = await member("/api/speak", { text: "Arabaya bin!", voice: "Charon", persona: "man_low", style: "loud" }, code2, { device: "tv-2" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-efex-cached"), "1");
  assert.equal(r.bytes.length, 5000);
  assert.equal(r.bytes[0], 1);
  assert.equal(r.bytes[4999], 2);
  assert.equal(ttsCalls.length, 0);
});

await t("dublaj: farklı ses ya da ton ayrı üretilir", async () => {
  ttsCalls.length = 0;
  await member("/api/speak", { text: "Arabaya bin!", voice: "Kore", persona: "woman_low", style: "loud" }, code);
  assert.equal(ttsCalls.length >= 1, true);
});

await t("dublaj: geçersiz ses reddedilir", async () => {
  const r = await member("/api/speak", { text: "Merhaba", voice: "Bilinmeyen", persona: "man_low" }, code);
  assert.equal(r.status, 400);
});

await t("dublaj: ses gelmezse ya da modeller yoksa anlaşılır hata, panelde Google mesajı", async () => {
  ttsBehavior["gemini-3.8-flash-tts"] = "empty";
  const r = await member("/api/speak", { text: "Hiç ses yok", voice: "Puck", persona: "man_high" }, code);
  assert.equal(r.status, 502);
  assert.equal(r.data.reason, "model");
  const o = await admin("overview");
  assert.match(o.data.ttsStatus.value, /^model\|/);
  assert.match(o.data.ttsStatus.value, /gemini-3.8-flash-lite-tts: HTTP 404/);
  ttsBehavior["gemini-3.8-flash-tts"] = "ok";
});

await t("dublaj: TTS_MODEL önce denenir", async () => {
  env.TTS_MODEL = "ozel-tts";
  ttsBehavior["ozel-tts"] = "ok";
  ttsCalls.length = 0;
  await member("/api/speak", { text: "Özel model", voice: "Leda", persona: "woman_high" }, code);
  assert.equal(ttsCalls[0].model, "ozel-tts");
  delete env.TTS_MODEL;
});

await t("dublaj: panel istatistikleri", async () => {
  const o = await admin("overview");
  assert.ok(o.data.today.tts_lines >= 3);
  assert.ok(o.data.today.tts_cached >= 1);
  assert.ok(o.data.audioPool.n >= 2);
});

// ---------------------------------------------------------------- yönetim
await t("kod kapatılır/açılır, cihaz sıfırlanır", async () => {
  await admin("members/toggle", { code });
  assert.equal((await member("/api/login", {}, code)).status, 403);
  await admin("members/toggle", { code });
  await admin("members/reset-device", { code });
  assert.equal((await member("/api/login", {}, code, { device: "yeni-tv" })).status, 200);
  assert.equal((await member("/api/login", {}, code, { device: "tv-1" })).status, 403);
});

await t("havuzdaki çeviri elle düzeltilir ve hemen kullanılır", async () => {
  const row = (await admin("pool/search", { q: "car" })).data.rows.find((x) => x.source === "Get in the car!");
  await admin("pool/edit", { hash: row.hash, target: "Bin arabaya!" });
  const r = await member("/api/translate", { lines: ["Get in the car!"] }, code, { device: "yeni-tv" });
  assert.deepEqual(r.data.translations, ["Bin arabaya!"]);
});

await t("0.1.0 ile kurulmuş eski veritabanı otomatik güncellenir", async () => {
  // Yeni bir modül örneği yükleyip eski şemayla başlat
  const old = makeD1();
  old._sql.exec(`CREATE TABLE members (code TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, daily_limit INTEGER NOT NULL, device_id TEXT, created_at TEXT NOT NULL, last_seen TEXT);
    CREATE TABLE usage (code TEXT NOT NULL, day TEXT NOT NULL, chars INTEGER NOT NULL DEFAULT 0, lines INTEGER NOT NULL DEFAULT 0, cached INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (code, day));
    INSERT INTO members VALUES ('EFEX-OLD0-OLD0','Eski',1,5000,NULL,'2026-11-24T00:00:00Z',NULL);`);
  const fresh = await import("../worker.js?fresh=" + Date.now());
  const res = await fresh.default.fetch(new Request("https://efex.test/admin/api/overview", { headers: { authorization: "Bearer gizli-sifre" } }), { ...env, DB: old });
  const d = await res.json();
  assert.equal(d.ok, true);
  assert.equal(d.members[0].name, "Eski");
  assert.equal(d.members[0].has_own_key, 0);
});

await t("üye silinir", async () => {
  await admin("members/delete", { code });
  assert.equal((await member("/api/login", {}, code, { device: "yeni-tv" })).status, 401);
});

// ---------------------------------------------------------------- güvenlik
await t("/indir son APK'ya yönlendirir", async () => {
  const res = await worker.fetch(new Request("https://efex.test/indir"), env);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /releases\/latest\/download\/efex-sub\.apk$/);
});

await t("panel güvenlik başlıkları", async () => {
  const res = await worker.fetch(new Request("https://efex.test/admin"), env);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

await t("ADMIN_PATH ile panel gizli adrese taşınır, /admin kapanır", async () => {
  env.ADMIN_PATH = "panel-x7k2";
  const a = await worker.fetch(new Request("https://efex.test/admin"), env);
  assert.equal(a.status, 404);
  const b = await worker.fetch(new Request("https://efex.test/panel-x7k2"), env);
  assert.equal(b.status, 200);
  const api = await worker.fetch(new Request("https://efex.test/panel-x7k2/api/overview", { headers: { authorization: "Bearer gizli-sifre" } }), env);
  assert.equal((await api.json()).hiddenPath, true);
  const oldApi = await worker.fetch(new Request("https://efex.test/admin/api/overview", { headers: { authorization: "Bearer gizli-sifre" } }), env);
  assert.equal(oldApi.status, 404);
  delete env.ADMIN_PATH;
});

await t("yanlış panel şifresi 5 denemede kilitlenir, doğru şifre de kilit süresince reddedilir", async () => {
  const req = (pw, ip) => worker.fetch(new Request("https://efex.test/admin/api/overview", { headers: { authorization: "Bearer " + pw, "cf-connecting-ip": ip } }), env);
  for (let i = 0; i < 4; i++) assert.equal((await req("yanlis", "1.2.3.4")).status, 401);
  assert.equal((await req("yanlis", "1.2.3.4")).status, 401); // 5. deneme kilidi başlatır
  const locked = await req("gizli-sifre", "1.2.3.4");
  assert.equal(locked.status, 429);
  // Başka IP etkilenmez
  assert.equal((await req("gizli-sifre", "5.6.7.8")).status, 200);
});

await t("doğru şifre hatalı deneme sayacını sıfırlar", async () => {
  const req = (pw) => worker.fetch(new Request("https://efex.test/admin/api/overview", { headers: { authorization: "Bearer " + pw, "cf-connecting-ip": "9.9.9.9" } }), env);
  for (let i = 0; i < 4; i++) await req("yanlis");
  assert.equal((await req("gizli-sifre")).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await req("yanlis")).status, 401);
  assert.equal((await req("gizli-sifre")).status, 200);
});

await t("geçersiz arkadaş kodu 10 denemede kilitlenir", async () => {
  const req = (code) => worker.fetch(new Request("https://efex.test/api/login", { method: "POST", headers: { "x-efex-code": code, "x-efex-device": "x", "cf-connecting-ip": "7.7.7.7" } }), env);
  for (let i = 0; i < 10; i++) assert.equal((await req("EFEX-AAAA-AAA" + i)).status, 401);
  assert.equal((await req("EFEX-AAAA-AAAA")).status, 429);
});

await t("sunucu hatasında iç ayrıntı sızmaz", async () => {
  const bad = { ...env, DB: { ...env.DB, prepare: () => { throw new Error("SECRET-INTERNAL"); }, batch: env.DB.batch } };
  const res = await worker.fetch(new Request("https://efex.test/api/login", { method: "POST" }), bad);
  const text = await res.text();
  assert.equal(res.status, 500);
  assert.ok(!text.includes("SECRET-INTERNAL"));
});

console.log(`\n${passed} test geçti`);
