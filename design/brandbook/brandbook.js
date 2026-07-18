(() => {
  "use strict";

  const root = document.documentElement;
  const themeButton = document.querySelector("[data-theme-toggle]");
  const themeLabel = document.querySelector("[data-theme-label]");
  const toast = document.querySelector(".copy-toast");
  const storageKey = "trace-brandbook-theme";

  function readStoredTheme() {
    try {
      const value = localStorage.getItem(storageKey);
      return value === "light" || value === "dark" ? value : null;
    } catch {
      return null;
    }
  }

  function storeTheme(theme) {
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      // The brandbook remains fully usable when file:// storage is unavailable.
    }
  }

  function setTheme(theme, persist = false) {
    root.dataset.theme = theme;
    if (themeButton) {
      const dark = theme === "dark";
      themeButton.setAttribute("aria-pressed", String(dark));
      if (themeLabel) themeLabel.textContent = dark ? "Light view" : "Dark view";
    }
    if (persist) storeTheme(theme);
  }

  setTheme(readStoredTheme() || root.dataset.theme || "light");

  themeButton?.addEventListener("click", () => {
    setTheme(root.dataset.theme === "dark" ? "light" : "dark", true);
  });

  document.querySelector("[data-print]")?.addEventListener("click", () => {
    window.print();
  });

  let toastTimer;

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 1800);
  }

  async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }

    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    if (!copied) throw new Error("Copy command was unavailable");
  }

  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      try {
        await copyText(button.dataset.copy || "");
        showToast("Copied to clipboard");
      } catch {
        showToast("Select the value and copy manually");
      }
    });
  }

  const lab = document.querySelector(".component-lab");
  const labButtons = [...document.querySelectorAll("[data-lab-theme]")];

  for (const button of labButtons) {
    button.addEventListener("click", () => {
      const theme = button.dataset.labTheme;
      if (lab && (theme === "light" || theme === "dark")) lab.dataset.lab = theme;
      for (const peer of labButtons) {
        const selected = peer === button;
        peer.classList.toggle("active", selected);
        peer.setAttribute("aria-pressed", String(selected));
      }
    });
  }

  const navLinks = [...document.querySelectorAll(".side-nav a")];
  const sectionById = new Map(
    navLinks
      .map((link) => [link.getAttribute("href")?.slice(1), link])
      .filter(([id]) => id),
  );

  function setActiveSection(id) {
    for (const [sectionId, link] of sectionById) {
      if (sectionId === id) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  }

  if ("IntersectionObserver" in window) {
    const visible = new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
          else visible.delete(entry.target.id);
        }
        const active = [...visible.entries()].sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]))[0];
        if (active) setActiveSection(active[0]);
      },
      { rootMargin: "-18% 0px -68% 0px", threshold: [0, 0.08, 0.4] },
    );

    for (const id of sectionById.keys()) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
  }
})();
