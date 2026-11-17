/* =====================================================================
   IQRAB LEAD — shared sign-up form + submission pipeline
   Used by:  /index.html (homepage pop-up)  and  /1000/index.html (gate)
   ---------------------------------------------------------------------
   CONFIG — edit these lines only:
   - LEAD_MODE  "direct" : browser POSTs straight to APPS_SCRIPT_URL
                           (text/plain + no-cors, no CORS preflight). Works on
                           ANY static host; /api/lead is never called.
                           Code.gs must have SHARED_SECRET = "".
                "worker" : browser POSTs to LEAD_ENDPOINT (/api/lead, the
                           Cloudflare _worker.js), which validates, rate-limits
                           and forwards with LEAD_SECRET. Needs Cloudflare env
                           APPS_SCRIPT_URL + LEAD_SECRET, and SHARED_SECRET in
                           Code.gs set to the same value as LEAD_SECRET.
   ===================================================================== */
const LEAD_MODE       = "direct";
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwVx4wE4-tqCWwCL2cyeBrTW9NbDsaKsKOcvKAtrvOGk1n5uA-jYvpekFLF82JvlOoy/exec";
const LEAD_ENDPOINT   = "/api/lead";

(function () {
  "use strict";
  const CFG = Object.assign({ LEAD_MODE, LEAD_ENDPOINT, APPS_SCRIPT_URL, TIMEOUT_MS: 10000 }, window.IQRAB_CONFIG || {});
  const K_LEAD = "iqrab.lead", K_QUEUE = "iqrab.leadQueue", K_REM = "iqrab.remember", K_SESS = "iqrab.leadSession";
  const CONSENT_TEXT = "Saya bersetuju maklumat peribadi saya (nama dan no. telefon) dikumpul dan digunakan oleh pihak Iqrab untuk menghubungi saya mengenai program-program Iqrab, selaras dengan Akta Perlindungan Data Peribadi 2010 (PDPA). Saya boleh menarik balik persetujuan ini pada bila-bila masa.";

  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const ss = {
    get(k, d) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  /* ---------- validation ---------- */
  function normalizePhone(raw) {
    const s = String(raw || "").replace(/[\s\-().]/g, "");
    // Malaysia: 012-345 6789, 011-2345 6789, 03-1234 5678, +60 12..., 60 12...
    let m = s.match(/^(?:\+?60|0)(1\d{8,9}|[3-9]\d{7,8})$/);
    if (m) return "+60" + m[1];
    // Other countries, international format only: +65 9123 4567 etc.
    m = s.match(/^(?:\+|00)([1-9]\d{7,14})$/);
    if (m && !m[1].startsWith("60")) return "+" + m[1];
    return null;
  }
  function validate(d) {
    const err = {};
    const name = String(d.name || "").trim().replace(/\s+/g, " ");
    if (name.length < 2) err.name = "Sila isi nama anda.";
    else if (name.length > 80) err.name = "Nama terlalu panjang.";
    const phone = normalizePhone(d.phone);
    if (!phone) err.phone = "Sila isi no. telefon yang sah, cth. 012-345 6789 atau +60 12-345 6789";
    if (!d.consent) err.consent = "Sila tandakan persetujuan PDPA untuk teruskan.";
    return { ok: !Object.keys(err).length, err, clean: { name, email: "", phone } };
  }

  /* ---------- state ---------- */
  // Permanent unlock (Ingat saya ticked) in localStorage; otherwise this browser session only.
  const isUnlocked = () => !!(ls.get(K_LEAD, null) || {}).unlocked || !!(ss.get(K_SESS, null) || {}).unlocked;
  const getLead = () => ls.get(K_LEAD, null) || ss.get(K_SESS, null);
  const getRemembered = () => ls.get(K_REM, null);
  function unlock(name, source, opt) {
    opt = opt || {};
    const rec = { unlocked: true, name, source, at: new Date().toISOString() };
    if (opt.remember === false) {
      ss.set(K_SESS, rec);
      ls.del(K_REM);
      if (!(ls.get(K_LEAD, null) || {}).unlocked) ls.del(K_LEAD);
    } else {
      ls.set(K_LEAD, rec);
      if (opt.phone) ls.set(K_REM, { name, phone: opt.phone });
    }
  }

  /* ---------- transport ---------- */
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  }
  // Resolves {status:"sent"} | {status:"invalid", err} | rejects (network/server -> caller queues)
  async function send(payload) {
    const body = JSON.stringify(payload);
    if (CFG.LEAD_MODE !== "worker" && CFG.APPS_SCRIPT_URL) {
      // Direct to Apps Script: text/plain + no-cors = no CORS preflight. Response is opaque.
      // Apps Script can take >10 s on a cold start (sheet + e-mail). A slow request is NOT a failure:
      // keep it running in the background and only queue it if it actually errors.
      const f = fetch(CFG.APPS_SCRIPT_URL, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, keepalive: true });
      try { await withTimeout(f, Math.min(CFG.TIMEOUT_MS, 6000)); }
      catch (e) { if (e && e.message === "timeout") { f.catch(() => enqueue(payload)); return { status: "sent", slow: true }; } throw e; }
      return { status: "sent" };
    }
    const r = await withTimeout(fetch(CFG.LEAD_ENDPOINT, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, keepalive: true }), CFG.TIMEOUT_MS);
    if (r.ok) return { status: "sent" };
    if (r.status === 400) { let j = {}; try { j = await r.json(); } catch (e) {} return { status: "invalid", err: j.errors || {} }; }
    throw new Error("http " + r.status);
  }
  function enqueue(p) { const q = ls.get(K_QUEUE, []); if (!q.some(x => x.id === p.id)) q.push(p); ls.set(K_QUEUE, q.slice(-20)); }
  let flushing = false;
  async function flushQueue() {
    if (flushing || (navigator.onLine === false)) return;
    flushing = true;
    try {
      let q = ls.get(K_QUEUE, []);
      for (const p of q.slice()) {
        try { const r = await send(Object.assign({}, p, { retried: true })); q = q.filter(x => x.id !== p.id); ls.set(K_QUEUE, q); if (r.status === "invalid") continue; }
        catch (e) { break; }               // still offline / server down: keep for later
      }
    } finally { flushing = false; }
  }
  window.addEventListener("online", flushQueue);
  if (document.readyState === "complete") setTimeout(flushQueue, 1500); else window.addEventListener("load", () => setTimeout(flushQueue, 1500));

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  /* ---------- form UI (self-styled, Iqrab theme) ---------- */
  const CSS = `
  .iql{font-family:"Plus Jakarta Sans",Inter,system-ui,sans-serif;color:#E2E8F0;text-align:left}
  .iql *{box-sizing:border-box}
  .iql-eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#F59E0B;background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.30);padding:5px 10px;border-radius:999px}
  .iql h2{font-size:clamp(21px,5.6vw,27px);line-height:1.22;font-weight:800;margin:12px 0 8px;color:#fff}
  .iql h2 em{font-style:normal;color:#F59E0B}
  .iql .iql-sub{font-size:14.5px;line-height:1.55;color:#CBD5E1;margin:0 0 12px}
  .iql ul{list-style:none;padding:0;margin:0 0 14px;display:grid;gap:7px}
  .iql li{position:relative;padding-left:27px;font-size:13.5px;line-height:1.45;color:#E2E8F0}
  .iql li::before{content:"";position:absolute;left:0;top:1px;width:18px;height:18px;border-radius:50%;background:rgba(16,185,129,.18) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2310B981' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12l5 5L20 7'/%3E%3C/svg%3E") center/11px no-repeat}
  .iql li b{color:#fff}
  .iql form{display:grid;gap:9px}
  .iql label.iql-f{display:grid;gap:4px;font-size:12.5px;font-weight:600;color:#94A3B8}
  .iql input[type=text],.iql input[type=email],.iql input[type=tel]{width:100%;font:inherit;font-size:16px;color:#F8FAFC;background:rgba(2,6,23,.55);border:1px solid rgba(148,163,184,.25);border-radius:12px;padding:11px 13px;outline:none;transition:border-color .15s,box-shadow .15s}
  .iql input:focus{border-color:#10B981;box-shadow:0 0 0 3px rgba(16,185,129,.25)}
  .iql input[aria-invalid=true]{border-color:#F87171}
  .iql .iql-err{min-height:0;font-size:12px;color:#FCA5A5;font-weight:500}
  .iql .iql-err:empty{display:none}
  .iql .iql-consent{display:flex;gap:10px;align-items:flex-start;font-size:12px;line-height:1.5;color:#CBD5E1;font-weight:400;background:rgba(15,23,42,.6);border:1px solid rgba(148,163,184,.14);border-radius:12px;padding:10px}
  .iql .iql-consent input{flex:0 0 20px;width:20px;height:20px;margin:1px 0 0;accent-color:#10B981}
  .iql .iql-consent a{color:#5EEAD4}
  .iql .iql-remember{display:flex;gap:9px;align-items:center;font-size:12px;line-height:1.4;color:#94A3B8;font-weight:400;padding:0 2px;cursor:pointer}
  .iql .iql-remember input{flex:0 0 18px;width:18px;height:18px;margin:0;accent-color:#10B981}
  .iql .iql-hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;overflow:hidden}
  .iql button.iql-cta,.iql a.iql-cta{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;font:inherit;font-size:16px;font-weight:800;color:#0A1F1C;background:linear-gradient(135deg,#F59E0B,#FBBF24);border:0;border-radius:14px;padding:14px 16px;cursor:pointer;text-decoration:none;box-shadow:0 10px 30px -10px rgba(245,158,11,.6)}
  .iql button.iql-cta:disabled{opacity:.7;cursor:wait}
  .iql .iql-trust{display:flex;gap:7px;align-items:flex-start;font-size:11.5px;line-height:1.45;color:#94A3B8;margin:2px 0 0}
  .iql .iql-soft{font-size:12.5px;color:#94A3B8;margin:12px 0 0;text-align:center}
  .iql .iql-soft a{color:#5EEAD4;font-weight:600;text-decoration:none}
  .iql .iql-soft a:hover{text-decoration:underline}
  .iql .iql-done{text-align:center;padding:8px 0}
  .iql .iql-done .iql-ic{width:56px;height:56px;border-radius:50%;margin:0 auto 10px;display:grid;place-items:center;background:rgba(16,185,129,.15);color:#10B981;font-size:28px}
  .iql .iql-note{font-size:12px;color:#94A3B8;margin-top:8px}
  `;
  function injectCss() { if (document.getElementById("iql-css")) return; const s = document.createElement("style"); s.id = "iql-css"; s.textContent = CSS; document.head.appendChild(s); }

  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /**
   * mountForm(container, {copy, source, onDone(name, queued)})
   * copy = {eyebrow, headline(html), sub, bullets[], cta, trust, softHtml, doneTitle, doneText, doneCta, doneHref}
   */
  function mountForm(el, opts) {
    injectCss();
    const c = opts.copy, n = "iql" + Math.random().toString(36).slice(2, 7);
    el.classList.add("iql");
    el.innerHTML = `
      ${c.eyebrow ? `<span class="iql-eyebrow">${c.eyebrow}</span>` : ""}
      <h2 id="${n}-t">${c.headline}</h2>
      <p class="iql-sub">${c.sub}</p>
      <ul>${c.bullets.map(b => `<li>${b}</li>`).join("")}</ul>
      <form novalidate>
        <label class="iql-f">Nama
          <input type="text" name="name" autocomplete="name" placeholder="Nama anda" maxlength="80" required aria-describedby="${n}-en">
          <span class="iql-err" id="${n}-en" aria-live="polite"></span></label>
        <label class="iql-f">No. telefon (WhatsApp)
          <input type="tel" name="phone" autocomplete="tel" inputmode="tel" placeholder="012-345 6789" maxlength="20" required aria-describedby="${n}-ep">
          <span class="iql-err" id="${n}-ep" aria-live="polite"></span></label>
        <label class="iql-remember"><input type="checkbox" name="remember" checked><span>Ingat saya pada peranti ini</span></label>
        <div class="iql-hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
        <label class="iql-consent"><input type="checkbox" name="consent" required aria-describedby="${n}-ec">
          <span>${CONSENT_TEXT} <a href="/privasi" target="_blank" rel="noopener">Notis privasi</a></span></label>
        <span class="iql-err" id="${n}-ec" aria-live="polite"></span>
        <span class="iql-err" id="${n}-eg" aria-live="polite"></span>
        <button class="iql-cta" type="submit">${c.cta}</button>
        <p class="iql-trust"><span aria-hidden="true">🔒</span><span>${c.trust}</span></p>
      </form>
      ${c.softHtml ? `<p class="iql-soft">${c.softHtml}</p>` : ""}`;
    const f = el.querySelector("form"), btn = f.querySelector("button");
    const rem = getRemembered();
    if (rem) { if (rem.name) f.elements.name.value = rem.name; if (rem.phone) f.elements.phone.value = rem.phone; f.elements.remember.checked = true; }
    const errEl = { name: `${n}-en`, phone: `${n}-ep`, consent: `${n}-ec` };
    const showErr = (err) => {
      for (const k in errEl) {
        document.getElementById(errEl[k]).textContent = err[k] || "";
        const inp = f.elements[k]; if (inp) inp.setAttribute("aria-invalid", err[k] ? "true" : "false");
      }
      const first = Object.keys(errEl).find(k => err[k]); if (first && f.elements[first]) f.elements[first].focus();
    };
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      document.getElementById(`${n}-eg`).textContent = "";
      const d = { name: f.elements.name.value, phone: f.elements.phone.value, consent: f.elements.consent.checked };
      const v = validate(d);
      if (!v.ok) return showErr(v.err);
      showErr({});
      btn.disabled = true; btn.textContent = "Sedang menghantar…";
      const payload = {
        id: uid(), ts: new Date().toISOString(), name: v.clean.name, email: "", phone: v.clean.phone,
        phoneRaw: String(d.phone).trim(), consent: true, consentText: CONSENT_TEXT, source: opts.source,
        page: location.href.split("#")[0], ua: navigator.userAgent.slice(0, 300), website: f.elements.website.value
      };
      let queued = false;
      if (payload.website) { /* honeypot hit: pretend success, send nothing */ }
      else {
        try {
          const r = await send(payload);
          if (r.status === "invalid") {
            btn.disabled = false; btn.textContent = c.cta;
            const err = r.err && Object.keys(r.err).length ? r.err : {};
            if (Object.keys(err).length) return showErr(err);
            document.getElementById(`${n}-eg`).textContent = "Maaf, maklumat tidak dapat diterima. Sila semak semula.";
            return;
          }
        } catch (err) { enqueue(payload); queued = true; }   // offline / server error: unlock anyway, retry later
      }
      unlock(payload.name, opts.source, { remember: f.elements.remember.checked, phone: payload.phone });
      if (opts.onDone) opts.onDone(payload.name, queued);
    });
    return { form: f, titleId: `${n}-t` };
  }

  window.IqrabLead = { isUnlocked, getLead, getRemembered, unlock, validate, normalizePhone, mountForm, flushQueue, esc, CONSENT_TEXT, _cfg: CFG, _keys: { K_LEAD, K_QUEUE, K_REM, K_SESS } };
})();
