# NotebookLM Clipper — Contexte projet pour Claude Code

## Vue d'ensemble

Extension Chrome (Manifest V3) qui permet d'ajouter n'importe quelle page web comme **source dans Google NotebookLM** en un clic, directement depuis le navigateur.

Développée pour contourner le fait que Twitter/X bloque les requêtes des services tiers (comme n8n), en exploitant le fait que le contenu est déjà rendu dans le navigateur.

---

## Pourquoi cette extension ?

Le flow initial était : Twitter → bot Telegram → n8n → NotebookLM. Problèmes :
- Twitter bloque les requêtes externes
- n8n nécessite un serveur payant

Solution : une extension Chrome qui opère **depuis l'intérieur du navigateur**, donc le contenu Twitter est déjà accessible, et qui utilise les **cookies déjà présents** pour s'authentifier à NotebookLM sans serveur.

---

## Fonctionnalités définies

### Sélection du notebook
- Liste de tous les notebooks de l'utilisateur
- Barre de recherche pour filtrer
- Système de favoris (⭐) — les favoris apparaissent en premier
- Mémorisation du dernier notebook utilisé (pré-sélectionné à la prochaine ouverture)

### Deux modes de capture

| Mode | Mécanisme | Défaut pour |
|------|-----------|-------------|
| **Texte** | Envoie l'URL au crawler NotebookLM | Toutes les pages |
| **PDF** | Capture silencieuse via `chrome.debugger` → `Page.printToPDF` → upload fichier | Twitter/X (auto-détecté) |

**Auto-détection Twitter** : si l'URL match `twitter.com` ou `x.com`, le mode PDF est sélectionné automatiquement. L'utilisateur peut toujours changer manuellement.

### Auth
- Zéro credential stocké
- Utilise les cookies Chrome existants (`credentials: 'include'`)
- Si non connecté à NotebookLM : message d'info + bouton redirect vers `notebooklm.google.com`

---

## Architecture des fichiers

```
notebooklm-clipper/
├── manifest.json           # MV3 — permissions: activeTab, storage, debugger, tabs
├── background.js           # Service worker — gère l'API et la capture PDF
├── lib/
│   └── api.js              # Client RPC NotebookLM (auth + notebooks + sources)
├── popup/
│   ├── popup.html
│   ├── popup.css           # Dark theme, minimaliste
│   └── popup.js            # Logique UI (favoris, search, sélection, mode)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## API NotebookLM (non officielle)

Basée sur le reverse engineering de [notebooklm-py](https://github.com/teng-lin/notebooklm-py).

### Endpoint principal
```
POST https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute
```
Format : `application/x-www-form-urlencoded` avec `f.req` et `at` (CSRF token).

### RPC Methods utilisés

| Méthode | ID | Usage |
|---------|----|-------|
| LIST_NOTEBOOKS | `wXbhsf` | Lister tous les notebooks |
| ADD_SOURCE | `izAoDd` | Ajouter une URL comme source |
| ADD_SOURCE_FILE | `o4cbdc` | Enregistrer un PDF uploadé comme source |

Upload endpoint : `https://notebooklm.google.com/upload/_/`

### Auth tokens
Extraits depuis la homepage `https://notebooklm.google.com/` :
- `SNlM0e` — CSRF token (dans le HTML de la page)
- `FdrFJe` — Session ID

Fetch avec `credentials: 'include'` suffit — pas besoin de lire les cookies manuellement.

### Format de requête batchexecute
```js
const fReq = JSON.stringify([[[methodId, JSON.stringify(params), null, "generic"]]]);

// URL params
url.searchParams.set("rpcids", methodId);
url.searchParams.set("source-path", sourcePath); // ex: "/notebook/NOTEBOOK_ID"
url.searchParams.set("f.sid", tokens.sessionId);
url.searchParams.set("hl", "fr");
url.searchParams.set("rt", "c");

// Body
body.set("f.req", fReq);
body.set("at", tokens.csrf);
```

### Format de réponse batchexecute
Réponse texte, préfixe anti-XSSI `)]}'\n` à supprimer.
Chercher les chunks de type `wrb.fr` avec l'ID de la méthode :
```js
// chunk[0] === "wrb.fr" && chunk[1] === methodId → chunk[2] contient le JSON
```

### Paramètres des méthodes (à valider/ajuster)

**LIST_NOTEBOOKS**
```js
params = [["fr"]]
```
Réponse : `data[0]` = array de notebooks, chaque notebook = `[id, title, updatedAt, ...]`

**ADD_SOURCE (URL)**
```js
params = [notebookId, [[url, null, null, null, null, null]], null, null]
```

**ADD_SOURCE_FILE (PDF)**
```js
// Après upload du fichier qui retourne un uploadId
params = [notebookId, [[null, null, uploadId, filename, null, null]], null, null]
```

> ⚠️ Ces formats de params sont **à vérifier** lors des premiers tests — c'est le point le plus susceptible d'être incorrect. Si ça échoue, capturer le trafic réseau depuis notebooklm.google.com avec les DevTools pour voir le vrai format `f.req`.

---

## État actuel du code

Le code de base est écrit et fonctionnel en structure. **Ce qui reste à valider et potentiellement corriger** :

1. **Parsing de réponse `batchexecute`** — la regex/logique de parsing dans `parseResponse()` dans `lib/api.js` est à tester en conditions réelles. Le format peut avoir plusieurs variantes.

2. **Format des params RPC** — notamment `ADD_SOURCE` et `ADD_SOURCE_FILE`. Si NotebookLM répond avec une erreur, capturer le vrai payload depuis les DevTools Network sur notebooklm.google.com.

3. **Upload PDF** — la fonction `uploadFile()` dans `lib/api.js` retourne un `uploadId` mais le format exact de la réponse de l'endpoint upload est à confirmer.

4. **`chrome.debugger` PDF** — fonctionne en théorie, mais la barre "Chrome is being debugged" apparaît pendant la capture. Acceptable pour usage perso, peut poser problème pour Chrome Web Store (à évaluer).

---

## Ce qui n'est PAS encore fait

- [ ] Tester et valider l'auth + `LIST_NOTEBOOKS` en conditions réelles
- [ ] Valider les formats de params pour `ADD_SOURCE` et `ADD_SOURCE_FILE`
- [ ] Tester l'upload PDF end-to-end
- [ ] Gérer le cas où l'utilisateur a 0 notebooks
- [ ] Icônes de meilleure qualité (les actuelles sont générées programmatiquement, très basiques)
- [ ] Potentiellement : content script pour extraction texte intelligente (si on veut enrichir le mode Texte)

---

## Contraintes et choix techniques

- **Manifest V3** — obligatoire pour Chrome Web Store
- **Pas de serveur** — tout se passe côté client, dans le navigateur
- **Pas de lib externe** — vanilla JS uniquement dans l'extension
- **Style** : dark theme, minimaliste, sobre — cohérent avec les préférences du dev (Théo, designer UI/UX, préfère les designs minimalistes)
- **Les APIs NotebookLM sont non officielles** — risque de breaking changes, acceptable pour usage perso + communautaire

---

## Références

- Repo utilisé pour le reverse engineering des RPC : https://github.com/teng-lin/notebooklm-py
- Doc RPC development : https://github.com/teng-lin/notebooklm-py/blob/main/docs/rpc-development.md
- Doc RPC reference : https://github.com/teng-lin/notebooklm-py/blob/main/docs/rpc-reference.md
