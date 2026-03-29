/**
 * Service Worker - NotebookLM Clipper
 * Gère la capture PDF via chrome.debugger et les appels API.
 */

import { listNotebooks, addSourceUrl, addSourcePdf, addSourceText, isSourceSaved, getAuthTokens, getUserEmail, setAuthUser, detectAccounts, getAuthUser } from "./lib/api.js";

// ─── Context Menus ────────────────────────────────────────────────────────────

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "quick-add-page",
      title: "Ajouter à NotebookLM",
      contexts: ["page", "link"],
    });
    chrome.contextMenus.create({
      id: "quick-add-selection",
      title: "Ajouter le texte sélectionné à NotebookLM",
      contexts: ["selection"],
    });
  });
}

chrome.runtime.onInstalled.addListener(setupContextMenus);
chrome.runtime.onStartup.addListener(setupContextMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  if (info.menuItemId === "quick-add-page") {
    await quickAddCurrentTab(tab.id, info.linkUrl || tab.url || "", null);
  } else if (info.menuItemId === "quick-add-selection") {
    await quickAddCurrentTab(tab.id, tab.url || "", info.selectionText || "");
  }
});

// ─── Keyboard Shortcut ────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "quick-add") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await quickAddCurrentTab(tab.id, tab.url || "", null);
});

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message });
  });
  return true; // Indique une réponse asynchrone
});

async function handleMessage(message) {
  switch (message.type) {
    case "CHECK_AUTH":
      return checkAuth();

    case "GET_USER_EMAIL":
      return { email: await getUserEmail() };

    case "DETECT_ACCOUNTS":
      return { accounts: await detectAccounts() };

    case "SET_ACCOUNT": {
      const { authuser } = message;
      setAuthUser(authuser);
      return { ok: true };
    }

    case "LIST_NOTEBOOKS":
      return { notebooks: await listNotebooks() };

    case "CHECK_SOURCE": {
      const { notebookId, url } = message;
      const saved = await isSourceSaved(notebookId, url);
      return { saved };
    }

    case "ADD_SOURCE": {
      const { notebookId, mode, tabId, selectedText } = message;
      const url = normalizeYouTubeUrl(message.url);
      if (mode === "pdf") {
        return addSourceAsPdf(notebookId, tabId, url);
      } else if (mode === "selection") {
        if (!selectedText) throw new Error("Aucun texte sélectionné");
        await addSourceText(notebookId, selectedText, selectionFilename(url));
        return { success: true };
      } else {
        await addSourceUrl(notebookId, url);
        return { success: true };
      }
    }

    case "GET_RAW_DATA": {
      const resp = await fetch("https://notebooklm.google.com/", {
        credentials: "include", cache: "no-store",
      });
      const html = await resp.text();
      const emailMatches = [...html.matchAll(/"([^"@\s]{3,50}@[^"@\s]{2,30}\.[^"@\s]{2,10})"/g)]
        .map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 5);
      let rpcRaw = null;
      try {
        const tokens = await getAuthTokens();
        const fReq = JSON.stringify([[["wXbhsf", JSON.stringify([["fr"]]), null, "generic"]]]);
        const url = new URL("https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute");
        url.searchParams.set("rpcids", "wXbhsf");
        url.searchParams.set("f.sid", tokens.sessionId);
        url.searchParams.set("hl", "fr");
        url.searchParams.set("rt", "c");
        url.searchParams.set("authuser", getAuthUser());
        const body = new URLSearchParams();
        body.set("f.req", fReq);
        body.set("at", tokens.csrf);
        const rpcResp = await fetch(url.toString(), {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
        rpcRaw = (await rpcResp.text()).substring(0, 2000);
      } catch(e) { rpcRaw = "erreur: " + e.message; }
      return { emailMatches, rpcRaw };
    }

    default:
      throw new Error(`Message inconnu: ${message.type}`);
  }
}

// ─── Auth Check ───────────────────────────────────────────────────────────────

async function checkAuth() {
  try {
    await getAuthTokens(true);
    const email = await getUserEmail();
    return { authenticated: true, email };
  } catch (e) {
    return { authenticated: false, error: e.message };
  }
}

// ─── PDF Capture ──────────────────────────────────────────────────────────────

/**
 * Capture le tab actif en PDF et l'envoie comme source.
 */
async function addSourceAsPdf(notebookId, tabId, url) {
  const pdfBuffer = await captureTabToPdf(tabId, url);
  await addSourcePdf(notebookId, pdfBuffer, urlToFilename(url));
  return { success: true };
}

/**
 * Capture un tab en PDF et retourne l'ArrayBuffer.
 */
async function captureTabToPdf(tabId, url) {
  const target = { tabId };
  await attachDebugger(target);
  try {
    // Injecter la bannière source directement dans le DOM
    const bannerText = JSON.stringify("Source : " + url);
    await sendDebugCommand(target, "Runtime.evaluate", {
      expression: `(function() {
        try {
          var s = document.createElement('style');
          s.textContent = '#__nlm_banner { all: unset !important; display: block !important; font-family: Arial, monospace !important; font-size: 11pt !important; color: #333 !important; background: #f5f5f5 !important; border-bottom: 1pt solid #ccc !important; padding: 8pt 14pt !important; margin: 0 0 14pt 0 !important; width: 100% !important; box-sizing: border-box !important; word-break: break-all !important; }';
          document.head.appendChild(s);
          document.getElementById('__nlm_banner')?.remove();
          var b = document.createElement('div');
          b.id = '__nlm_banner';
          b.textContent = ${bannerText};
          document.body.insertBefore(b, document.body.firstChild);
        } catch(e) {}
      })()`,
    });

    const result = await sendDebugCommand(target, "Page.printToPDF", {
      printBackground: true,
      transferMode: "ReturnAsBase64",
    });
    await detachDebugger(target);
    if (!result?.data) throw new Error("Génération PDF échouée");
    return base64ToArrayBuffer(result.data);
  } catch (err) {
    try { await detachDebugger(target); } catch { /* ignored */ }
    throw err;
  }
}

// ─── Debugger Helpers ─────────────────────────────────────────────────────────

function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function detachDebugger(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => { resolve(); });
  });
}

function sendDebugCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// ─── Utils ────────────────────────────────────────────────────────────────────

let _badgeTimer = null;

function showBadge(success) {
  if (_badgeTimer) clearTimeout(_badgeTimer);
  chrome.action.setBadgeText({ text: success ? "✓" : "!" });
  chrome.action.setBadgeBackgroundColor({ color: success ? "#1e7e34" : "#c0392b" });
  _badgeTimer = setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
    _badgeTimer = null;
  }, 3000);
}

async function quickAddCurrentTab(tabId, url, selectionText) {
  const stored = await chrome.storage.local.get(["lastNotebook", "authUser"]);
  if (stored.authUser != null) setAuthUser(stored.authUser);
  const notebookId = stored.lastNotebook;
  if (!notebookId) { showBadge(false); return; }
  try {
    if (selectionText) {
      await addSourceText(notebookId, selectionText, selectionFilename(url));
    } else {
      await addSourceUrl(notebookId, normalizeYouTubeUrl(url));
    }
    showBadge(true);
  } catch {
    showBadge(false);
  }
}

function normalizeYouTubeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace("www.", "");
    if (host === "youtube.com" && u.pathname === "/watch") {
      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/watch?v=${v}`;
    }
    if (host === "youtu.be") {
      const v = u.pathname.slice(1);
      if (v) return `https://www.youtube.com/watch?v=${v}`;
    }
  } catch { /* ignored */ }
  return url;
}

function selectionFilename(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace("www.", "").replace(/\./g, "_");
    return `selection_${host}.txt`;
  } catch {
    return "selection.txt";
  }
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function urlToFilename(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace("www.", "");
    const path = parsed.pathname.replace(/\//g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
    const name = `${hostname}${path || "_page"}`.slice(0, 80);
    return `${name}.pdf`;
  } catch {
    return "page.pdf";
  }
}
