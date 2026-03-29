/**
 * Service Worker - NotebookLM Clipper
 * Gère la capture PDF via chrome.debugger et les appels API.
 */

import { listNotebooks, addSourceUrl, addSourcePdf, isSourceSaved, getAuthTokens, getUserEmail, setAuthUser, detectAccounts, getAuthUser } from "./lib/api.js";

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
      const { notebookId, mode, tabId, url } = message;
      if (mode === "pdf") {
        return addSourceAsPdf(notebookId, tabId, url);
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

async function addSourceAsPdf(notebookId, tabId, url) {
  const target = { tabId };

  try {
    await attachDebugger(target);

    // Injecter la bannière URL en haut du DOM avant le print
    const escapedUrl = url.replace(/'/g, "\\'");
    await sendDebugCommand(target, "Runtime.evaluate", {
      expression: `(function() {
        var b = document.createElement('div');
        b.id = '__nlm_source_banner';
        b.style.cssText = 'all:unset;display:block;font-family:monospace;font-size:13px;color:#222;background:#f5f5f5;border-bottom:1px solid #ccc;padding:8px 14px;word-break:break-all;';
        b.textContent = 'Source : ${escapedUrl}';
        document.body.insertBefore(b, document.body.firstChild);
      })()`,
    });

    const result = await sendDebugCommand(target, "Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      transferMode: "ReturnAsBase64",
    });

    await detachDebugger(target);

    if (!result || !result.data) {
      throw new Error("Génération PDF échouée");
    }

    const pdfBuffer = base64ToArrayBuffer(result.data);
    const filename = urlToFilename(url);
    await addSourcePdf(notebookId, pdfBuffer, filename);

    return { success: true };
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
