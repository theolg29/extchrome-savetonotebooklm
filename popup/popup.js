/**
 * Popup Script - NotebookLM Clipper
 */

function dbg(...args) {
  console.log("[Clipper]", ...args);
}

window.addEventListener("error", e => dbg("ERROR:", e.message, e.filename, "L" + e.lineno));
window.addEventListener("unhandledrejection", e => dbg("UNHANDLED:", e.reason?.message || e.reason));

// ─── Storage helpers ──────────────────────────────────────────────────────────

const Storage = {
  async get(key, fallback = null) {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? fallback;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
};

// ─── State ────────────────────────────────────────────────────────────────────

let allNotebooks = [];
let selectedNotebookId = null;
let favorites = [];
let isTwitter = false;
let currentTabUrl = "";
let currentTabId = null;
let selectedText = "";

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  dbg("init() démarré");
  setLoadingText("Chargement…");
  showState("loading");

  // Récupérer l'onglet actif
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabUrl = tab.url || "";
    currentTabId = tab.id;
    isTwitter = /^https?:\/\/(www\.)?(twitter\.com|x\.com)/.test(currentTabUrl);
    // Récupérer le texte sélectionné dans l'onglet actif
    try {
      let sel;
      try {
        sel = await chrome.tabs.sendMessage(currentTabId, { type: "GET_SELECTION" });
      } catch {
        // Content script absent (onglet ouvert avant le reload) — l'injecter à la volée
        await chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: ["content.js"] });
        sel = await chrome.tabs.sendMessage(currentTabId, { type: "GET_SELECTION" });
      }
      selectedText = sel?.text || "";
    } catch {
      selectedText = "";
    }
  }

  dbg("onglet récupéré:", currentTabUrl, "sélection:", selectedText.length, "chars");

  // ── Gestion du compte ─────────────────────────────────────────────────────

  // Vérifier si un compte a déjà été sélectionné
  const savedAuthUser = await Storage.get("authUser", null);

  if (savedAuthUser !== null) {
    // Utiliser le compte sauvegardé directement
    dbg("compte sauvegardé:", savedAuthUser);
    await sendMessage({ type: "SET_ACCOUNT", authuser: savedAuthUser });
    await loadWithAuth();
  } else {
    // Détecter les comptes disponibles
    setLoadingText("Détection des comptes Google…");
    dbg("détection des comptes...");

    let authResult;
    try {
      authResult = await sendMessage({ type: "CHECK_AUTH" });
      dbg("CHECK_AUTH:", authResult);
    } catch (err) {
      dbg("CHECK_AUTH erreur:", err.message);
      showError(err.message || "Impossible de contacter le service worker");
      return;
    }

    if (!authResult.authenticated) {
      dbg("non authentifié:", authResult.error);
      showState("unauth");
      return;
    }

    let accounts;
    try {
      const result = await sendMessage({ type: "DETECT_ACCOUNTS" });
      accounts = result.accounts || [];
      dbg("comptes détectés:", accounts);
    } catch (err) {
      dbg("DETECT_ACCOUNTS erreur:", err.message);
      // Fallback: utiliser authuser=0
      accounts = authResult.email ? [{ authuser: 0, email: authResult.email }] : [];
    }

    if (accounts.length <= 1) {
      // Un seul compte : on le sélectionne directement
      const authuser = accounts[0]?.authuser ?? 0;
      await Storage.set("authUser", authuser);
      await sendMessage({ type: "SET_ACCOUNT", authuser });
      await loadWithAuth();
    } else {
      // Plusieurs comptes : afficher le sélecteur
      renderAccounts(accounts);
      showState("account");
    }
  }
}

/**
 * Charge les notebooks une fois le compte sélectionné.
 */
async function loadWithAuth() {
  // Récupérer l'email du compte actif
  dbg("vérification auth...");
  let authResult;
  try {
    authResult = await sendMessage({ type: "CHECK_AUTH" });
    dbg("CHECK_AUTH:", authResult);
  } catch (err) {
    showError(err.message || "Impossible de contacter le service worker");
    return;
  }

  if (!authResult.authenticated) {
    showState("unauth");
    return;
  }

  if (authResult.email) {
    showUserBadge(authResult.email);
  }

  // Charger favorites + dernier notebook
  favorites = await Storage.get("favorites", []);
  const lastNotebook = await Storage.get("lastNotebook", null);

  // Charger les notebooks
  dbg("chargement notebooks...");
  setLoadingText("Chargement des notebooks…");
  let notebooks;
  try {
    const result = await sendMessage({ type: "LIST_NOTEBOOKS" });
    notebooks = result.notebooks || [];
    dbg("notebooks reçus:", notebooks.length);
  } catch (err) {
    dbg("LIST_NOTEBOOKS erreur:", err.message);
    showError(err.message || "Impossible de charger les notebooks");
    return;
  }

  allNotebooks = notebooks;

  if (selectedText) {
    const pill = document.getElementById("pill-selection");
    if (pill) pill.classList.remove("hidden");
    setMode("selection");
  } else if (isTwitter) {
    setMode("pdf");
  } else {
    setMode("text");
  }

  if (lastNotebook && notebooks.some((n) => n.id === lastNotebook)) {
    selectedNotebookId = lastNotebook;
  }

  renderNotebooks(notebooks);
  showState("main");
  updateAddButton();
  dbg("init() terminé OK");
}

// ─── Account Selection ────────────────────────────────────────────────────────

function renderAccounts(accounts) {
  const list = document.getElementById("account-list");
  list.innerHTML = "";

  accounts.forEach(({ authuser, email }) => {
    const item = document.createElement("button");
    item.className = "account-item";
    const initial = email.charAt(0).toUpperCase();
    item.innerHTML = `
      <div class="account-avatar">${initial}</div>
      <div class="account-info">
        <span class="account-email">${escapeHtml(email)}</span>
        <span class="account-sub">Compte Google ${authuser + 1}</span>
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" class="account-arrow">
        <path d="M9 6L15 12L9 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    item.addEventListener("click", async () => {
      await Storage.set("authUser", authuser);
      await sendMessage({ type: "SET_ACCOUNT", authuser });
      setLoadingText("Chargement des notebooks…");
      showState("loading");
      await loadWithAuth();
    });
    list.appendChild(item);
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderNotebooks(notebooks) {
  const list = document.getElementById("notebook-list") || document.querySelector(".nb-list");
  list.innerHTML = "";

  if (notebooks.length === 0) {
    list.innerHTML = '<p class="empty-state">Aucun notebook trouvé.</p>';
    return;
  }

  const favoritedNotebooks = notebooks.filter((nb) => favorites.includes(nb.id));
  const regularNotebooks = notebooks.filter((nb) => !favorites.includes(nb.id));

  if (favoritedNotebooks.length > 0) {
    list.appendChild(createSectionLabel("⭐ Favoris"));
    favoritedNotebooks.forEach((nb) => list.appendChild(createNotebookItem(nb)));
  }

  if (regularNotebooks.length > 0) {
    const label = favoritedNotebooks.length > 0 ? "Tous les notebooks" : "Notebooks";
    list.appendChild(createSectionLabel(label));
    regularNotebooks.forEach((nb) => list.appendChild(createNotebookItem(nb)));
  }
}

function createSectionLabel(text) {
  const el = document.createElement("div");
  el.className = "section-label";
  el.textContent = text;
  return el;
}

function createNotebookItem(notebook) {
  const item = document.createElement("div");
  item.className = "nb-item";
  item.dataset.id = notebook.id;

  if (notebook.id === selectedNotebookId) {
    item.classList.add("selected");
  }

  const isFav = favorites.includes(notebook.id);

  item.innerHTML = `
    <span class="nb-dot"></span>
    <span class="nb-name" title="${escapeHtml(notebook.title)}">${escapeHtml(notebook.title)}</span>
    <button class="star-btn ${isFav ? "starred" : ""}" data-id="${notebook.id}" title="${isFav ? "Retirer des favoris" : "Ajouter aux favoris"}">
      ${isFav ? "★" : "☆"}
    </button>
  `;

  item.addEventListener("click", (e) => {
    if (e.target.closest(".star-btn")) return;
    selectNotebook(notebook.id);
  });

  item.querySelector(".star-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(notebook.id);
  });

  return item;
}

function selectNotebook(id) {
  selectedNotebookId = id;
  document.querySelectorAll(".nb-item").forEach((item) => {
    item.classList.toggle("selected", item.dataset.id === id);
  });
  updateAddButton();
  checkSourceStatus(id);
}

let _checkAbortId = 0;

async function checkSourceStatus(notebookId) {
  const checkId = ++_checkAbortId;
  const el = document.getElementById("source-status");
  if (!el || !currentTabUrl) return;

  el.className = "source-status";
  el.textContent = "Vérification…";
  el.classList.remove("hidden");

  try {
    const { saved } = await sendMessage({ type: "CHECK_SOURCE", notebookId, url: currentTabUrl });
    if (checkId !== _checkAbortId) return; // sélection changée entre-temps
    if (saved) {
      el.className = "source-status saved";
      el.textContent = "Déjà enregistré dans ce notebook";
    } else {
      el.classList.add("hidden");
      el.textContent = "";
    }
  } catch {
    if (checkId === _checkAbortId) el.classList.add("hidden");
  }
}

function toggleFavorite(id) {
  if (favorites.includes(id)) {
    favorites = favorites.filter((f) => f !== id);
  } else {
    favorites = [...favorites, id];
  }

  Storage.set("favorites", favorites);

  const query = document.getElementById("search-input").value.trim().toLowerCase();
  const filtered = query
    ? allNotebooks.filter((nb) => nb.title.toLowerCase().includes(query))
    : allNotebooks;

  renderNotebooks(filtered);

  if (selectedNotebookId) {
    document.querySelectorAll(".nb-item").forEach((item) => {
      item.classList.toggle("selected", item.dataset.id === selectedNotebookId);
    });
  }
}

// ─── Add Source ───────────────────────────────────────────────────────────────

function getMode() {
  return document.querySelector(".mode-pill.active")?.dataset.mode || "text";
}

function setMode(mode) {
  document.querySelectorAll(".mode-pill").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
}

async function handleAddSource() {
  if (!selectedNotebookId) return;

  const mode = getMode();
  setLoading(true);

  dbg(`ADD_SOURCE: mode=${mode}, notebookId=${selectedNotebookId}, url=${currentTabUrl}`);
  try {
    await sendMessage({
      type: "ADD_SOURCE",
      notebookId: selectedNotebookId,
      mode,
      tabId: currentTabId,
      url: currentTabUrl,
      selectedText: mode === "selection" ? selectedText : undefined,
    });

    await Storage.set("lastNotebook", selectedNotebookId);

    const notebook = allNotebooks.find((n) => n.id === selectedNotebookId);
    dbg("ADD_SOURCE: succès");
    showToast(`Ajouté à "${notebook?.title || "notebook"}" ✓`, "success");

    setTimeout(() => window.close(), 1500);
  } catch (err) {
    dbg("ADD_SOURCE erreur:", err.message);
    showToast(err.message || "Erreur lors de l'ajout", "error");
    setLoading(false);
  }
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function showUserBadge(email) {
  const badge = document.getElementById("user-badge");
  const emailEl = document.getElementById("user-email");
  if (badge && emailEl) {
    emailEl.textContent = email;
    emailEl.title = email;
    badge.classList.remove("hidden");
  }
}

function setLoadingText(text) {
  const el = document.getElementById("loading-text");
  if (el) el.textContent = text;
}

function showState(name) {
  ["unauth", "loading", "error", "account", "main"].forEach((s) => {
    const el = document.getElementById(`state-${s}`);
    if (el) el.classList.toggle("hidden", s !== name);
  });
}

function showError(message) {
  document.getElementById("error-message").textContent = message;
  showState("error");
}

function updateAddButton() {
  const btn = document.getElementById("btn-add");
  btn.disabled = !selectedNotebookId;
}

function setLoading(isLoading) {
  const btn = document.getElementById("btn-add");
  const label = document.getElementById("btn-label");
  const spinner = document.getElementById("btn-spinner");

  btn.disabled = isLoading;
  label.textContent = isLoading ? "Ajout en cours…" : "Ajouter";
  spinner.classList.toggle("hidden", !isLoading);
}

function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  const toastMsg = document.getElementById("toast-message");

  toast.className = `toast ${type}`;
  toastMsg.textContent = message;

  void toast.offsetWidth;
  toast.classList.add("visible");

  setTimeout(() => {
    toast.classList.remove("visible");
  }, 2500);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

function escapeHtml(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

document.getElementById("btn-add").addEventListener("click", handleAddSource);
document.getElementById("btn-retry").addEventListener("click", init);

document.querySelectorAll(".mode-pill").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

// Clic sur le badge email → changer de compte
document.getElementById("user-badge").addEventListener("click", async () => {
  await Storage.set("authUser", null);
  // Réinitialiser et relancer la détection
  allNotebooks = [];
  selectedNotebookId = null;
  init();
});

document.getElementById("search-input").addEventListener("input", (e) => {
  const query = e.target.value.trim().toLowerCase();
  const filtered = query
    ? allNotebooks.filter((nb) => nb.title.toLowerCase().includes(query))
    : allNotebooks;
  renderNotebooks(filtered);

  if (selectedNotebookId) {
    const item = document.querySelector(`.nb-item[data-id="${selectedNotebookId}"]`);
    item?.classList.add("selected");
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

init().catch((err) => {
  showError(err.message || "Erreur inattendue");
  dbg("❌ init catch:", err.message);
});

