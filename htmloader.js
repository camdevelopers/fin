(function () {
  "use strict";

  const API = "https://api.github.com";

  function getSettings() {
    return JSON.parse(localStorage.getItem("office-settings") || "{}");
  }

  function getCache() {
    return JSON.parse(localStorage.getItem("pages") || "{}");
  }

  function setCache(name, html) {
    const pages = getCache();
    pages[name] = html;
    localStorage.setItem("pages", JSON.stringify(pages));
  }

  async function fetchPrivate(path) {
    const s = getSettings();
    const branch = s.branch || "main";
    const res = await fetch(
      `${API}/repos/${s.owner}/${s.repo}/contents/${path}?ref=${branch}`,
      {
        headers: {
          Authorization: `Bearer ${s.pat}`,
          Accept: "application/vnd.github.raw",
        },
      }
    );
    if (res.status === 401) {
      const st = getSettings();
      delete st.pat;
      localStorage.setItem("office-settings", JSON.stringify(st));
      alert("Token invalid or expired.");
      throw new Error("401");
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
    return res.text();
  }

  async function fetchPublic(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Fetch ${path}: ${res.status}`);
    return res.text();
  }

  function executeScripts(container) {
    container.querySelectorAll("script").forEach((s) => {
      const el = document.createElement("script");
      el.textContent = s.textContent;
      s.replaceWith(el);
    });
  }

  function injectPage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");

    const headHTML = doc.head.innerHTML;
    if (headHTML) {
      document.head.insertAdjacentHTML("beforeend", headHTML);
      executeScripts(document.head);
    }

    const container = document.getElementById("content");
    container.innerHTML = doc.body.innerHTML;
    executeScripts(container);
  }

  async function loadPage(name) {
    const cache = getCache();

    if (cache[name]) {
      injectPage(cache[name]);
      return;
    }

    let html;
    if (name === "settings") {
      html = await fetchPublic("settings.html");
    } else {
      html = await fetchPrivate(`${name}.html`);
    }

    setCache(name, html);
    injectPage(html);
  }

  // --- Nav handler (delegated) ---
  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-page]");
    if (!link) return;
    e.preventDefault();
    loadPage(link.dataset.page).catch((err) => {
      console.error(err);
      document.getElementById("content").innerHTML =
        `<p style="color:red">Failed to load page: ${err.message}</p>`;
    });
  });

  // --- Init ---
  document.addEventListener("DOMContentLoaded", () => {
    const s = getSettings();
    if (!s.owner || !s.repo || !s.pat) {
      loadPage("settings").catch(console.error);
    } else {
      loadPage("home").catch(console.error);
    }
  });

  // Expose for external use (e.g., destale button)
  window.loadPage = loadPage;
})();   
