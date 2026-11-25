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
