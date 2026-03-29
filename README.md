# NotebookLM Clipper

Extension Chrome pour ajouter n'importe quelle page web comme source dans NotebookLM.

## Installation (dev)

1. Ouvrir `chrome://extensions`
2. Activer le **Mode développeur** (en haut à droite)
3. Cliquer **Charger l'extension non empaquetée**
4. Sélectionner ce dossier

## Utilisation

1. Aller sur une page web (Twitter, article, etc.)
2. Cliquer sur l'icône de l'extension
3. Sélectionner le notebook cible (⭐ pour les favoris)
4. Choisir le mode : **Texte** (URL) ou **PDF**
5. Cliquer **Ajouter**

### Modes

| Mode | Fonctionnement | Idéal pour |
|------|---------------|------------|
| **Texte** | Envoie l'URL au crawler NotebookLM | Articles, Wikipedia, docs |
| **PDF** | Capture silencieuse via DevTools, upload fichier | Twitter/X, pages protégées, contenu visuel |

Sur Twitter/X, le mode PDF est sélectionné automatiquement.

---

## Architecture

```
notebooklm-clipper/
├── manifest.json          # MV3
├── background.js          # Service worker (API calls, PDF capture)
├── lib/
│   └── api.js             # Client RPC NotebookLM
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── icons/
```

### Auth flow

L'extension utilise les cookies Chrome déjà présents (via `credentials: 'include'`).
Aucun stockage de credentials nécessaire — si vous êtes connecté à NotebookLM dans Chrome, ça fonctionne.

Tokens requis, extraits depuis la homepage NotebookLM :
- `SNlM0e` — CSRF token (dans `WIZ_global_data`)
- `FdrFJe` — Session ID (dans `WIZ_global_data`)

### Endpoints RPC utilisés

Basés sur [notebooklm-py](https://github.com/teng-lin/notebooklm-py).

| Méthode | ID RPC | Usage |
|---------|--------|-------|
| LIST_NOTEBOOKS | `wXbhsf` | Récupérer tous les notebooks |
| ADD_SOURCE | `izAoDd` | Ajouter une URL comme source |
| ADD_SOURCE_FILE | `o4cbdc` | Enregistrer un PDF uploadé |

Endpoint : `POST https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute`

### PDF Capture

Utilise `chrome.debugger` avec la commande `Page.printToPDF`.
Une barre "Chrome is being debugged" apparaît brièvement pendant la capture.

---

## ⚠️ Notes importantes

- Ces APIs sont **non officielles** et peuvent changer à tout moment
- Si l'extension cesse de fonctionner, vérifier les RPC IDs dans `lib/api.js`
- Pour déboguer les appels RPC : ouvrir les DevTools de la popup (`Inspect popup`)

### Déboguer les payloads RPC

Si `addSourceUrl` ou `addSourcePdf` échoue, le format des params
peut avoir changé. Capturer le trafic depuis notebooklm.google.com
avec les DevTools Network pour vérifier le format `f.req`.

Voir : https://github.com/teng-lin/notebooklm-py/blob/main/docs/rpc-development.md
