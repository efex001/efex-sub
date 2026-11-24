
// ---------------------------------------------------------------- giriş noktası

export default {
  async fetch(request, env) {
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
      return err("Bulunamadı", 404);
    } catch (e) {
      console.error(e);
      return err("Sunucu hatası", 500);
    }
  },
};
