/*
  Config-web presets-only theme switcher. Black/Red (brand-red) default + Light variant (derived from Black/Red).
  Persists to localStorage; injects a fixed toggle so no per-page header markup is needed.
  (The live custom Primary/Secondary picker is CLIENT-only — config-web ships presets only.)
*/
(function () {
  var KEY = "configweb-ui-theme";
  var PRESETS = ["brand-red", "light"];
  var LABEL = { "brand-red": "Theme: Black/Red", light: "Theme: Light" };

  function current() {
    var t = localStorage.getItem(KEY);
    if (t === "fumbbl") t = "light"; // the light preset was called "fumbbl" before 10-31
    return PRESETS.indexOf(t) >= 0 ? t : "brand-red";
  }
  function apply(t) {
    document.documentElement.setAttribute("data-theme", t);
    var btn = document.getElementById("theme-toggle-btn");
    if (btn) btn.textContent = LABEL[t];
  }
  // Apply saved theme ASAP (attribute on <html> — set before first paint where possible).
  apply(current());

  function cycle() {
    var next = PRESETS[(PRESETS.indexOf(current()) + 1) % PRESETS.length];
    localStorage.setItem(KEY, next);
    apply(next);
  }

  function injectToggle() {
    if (document.getElementById("theme-toggle-btn")) return;
    var btn = document.createElement("button");
    btn.id = "theme-toggle-btn";
    btn.className = "theme-toggle";
    btn.type = "button";
    btn.textContent = LABEL[current()];
    btn.addEventListener("click", cycle);
    document.body.appendChild(btn);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectToggle);
  } else {
    injectToggle();
  }
})();
