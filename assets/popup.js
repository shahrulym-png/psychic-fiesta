/* =====================================================================
   IQRAB — homepage pop-up (lead capture for Iqrab 1000)
   Opens on the first of: 9 s on page · 45% scroll · exit-intent (desktop)
   · any [data-open-lead] button. Not shown again for DISMISS_DAYS after
   closing, and never after sign-up (then buttons just go to /1000/).
   ===================================================================== */
(function () {
  "use strict";
  const DELAY_MS = 9000, SCROLL_PCT = 0.45, DISMISS_DAYS = 3, K_DISMISS = "iqrab.popupDismissedAt", APP_URL = "/1000/";
  const L = window.IqrabLead, C = window.IQRAB_COPY;
  const modal = document.getElementById("leadModal");
  if (!L || !C || !modal) return;
  const panel = modal.querySelector(".lm-panel"), body = document.getElementById("leadBody");
  document.getElementById("leadLater").textContent = C.popup.dismiss;

  const dismissedRecently = () => { const t = +localStorage.getItem(K_DISMISS) || 0; return Date.now() - t < DISMISS_DAYS * 864e5; };
  let isOpen = false, autoDone = false, lastFocus = null, mounted = false;

  function mount() {
    if (mounted) return; mounted = true;
    L.mountForm(body, { source: "popup-home", copy: Object.assign({}, C.popup, { trust: C.trust, softHtml: C.popup.soft }), onDone(name, queued) { document.getElementById("leadLater").textContent = "Tutup";
      body.innerHTML = `<div class="iql-done"><div class="iql-ic" aria-hidden="true">✓</div><h2 id="leadTitle" tabindex="-1">${C.done.title}</h2>
        <p class="iql-sub">${C.done.text}</p><a class="iql-cta" href="${APP_URL}">${C.done.cta}</a>
        ${queued ? `<p class="iql-note">${C.done.queued}</p>` : ""}</div>`;
      document.getElementById("leadLater").hidden = true;
      document.getElementById("leadTitle").focus();
    }});
    body.querySelector("h2").id = "leadTitle";
  }
  const focusables = () => [...panel.querySelectorAll('a[href],button:not([disabled]),input:not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])')].filter(e => e.offsetParent !== null || e === document.activeElement);

  function open(byUser) {
    if (isOpen) return;
    if (L.isUnlocked()) { if (byUser) location.href = APP_URL; return; }
    mount();
    isOpen = true; autoDone = true; lastFocus = document.activeElement;
    modal.hidden = false; document.body.classList.add("lm-lock");
    requestAnimationFrame(() => modal.classList.add("open"));
    setTimeout(() => { const i = panel.querySelector("input[name=name]"); (i && matchMedia("(pointer:fine)").matches ? i : panel.querySelector(".lm-x")).focus(); }, 60);
  }
  function close() {
    if (!isOpen) return;
    isOpen = false; modal.classList.remove("open"); document.body.classList.remove("lm-lock");
    setTimeout(() => { modal.hidden = true; }, 200);
    if (!L.isUnlocked()) localStorage.setItem(K_DISMISS, String(Date.now()));
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  window.IqrabPopup = { open: () => open(true), close };

  // CTA buttons: links to /1000/ still work without JS; with JS they open the pop-up first.
  document.addEventListener("click", (e) => {
    const o = e.target.closest("[data-open-lead]");
    if (o) { if (!L.isUnlocked()) { e.preventDefault(); open(true); } return; }
    if (e.target.closest("[data-close-lead]")) { e.preventDefault(); const a = e.target.closest("a[href^='#']"); close(); if (a) location.hash = a.getAttribute("href"); }
  });
  modal.addEventListener("mousedown", (e) => { if (e.target === modal) close(); });   // backdrop click
  document.addEventListener("keydown", (e) => {
    if (!isOpen) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab") {                                         // focus trap
      const f = focusables(); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  });

  // Automatic triggers (first one wins)
  if (L.isUnlocked() || dismissedRecently()) return;
  const auto = () => { if (!autoDone && !L.isUnlocked() && !dismissedRecently()) open(false); cleanup(); };
  const timer = setTimeout(auto, DELAY_MS);
  const onScroll = () => { const h = document.documentElement.scrollHeight - innerHeight; if (h > 0 && scrollY / h >= SCROLL_PCT) auto(); };
  const onOut = (e) => { if (!e.relatedTarget && e.clientY <= 0) auto(); };
  const desktop = matchMedia("(pointer:fine)").matches;
  addEventListener("scroll", onScroll, { passive: true });
  if (desktop) document.addEventListener("mouseout", onOut);
  function cleanup() { clearTimeout(timer); removeEventListener("scroll", onScroll); document.removeEventListener("mouseout", onOut); }
})();
