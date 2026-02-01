# AntiDetect Browser

Un navigateur antidetect similaire à GoLogin et AdsPower, conçu pour gérer plusieurs profils de navigateur avec des empreintes digitales uniques.

## État actuel du développement

✅ **Complété:**
- Structure du projet avec Electron + React + TypeScript
- Interface desktop de base avec gestion des fenêtres
- Dashboard principal avec UI moderne (dark theme)
- Système de création et gestion de profils
- Interface de création de profil avec paramètres de base
- Stockage local des profils avec electron-store

🚧 **En cours:**
- Intégration complète avec Chromium
- Implémentation des paramètres de fingerprinting
- Système de proxies
- Isolation des profils

## Installation

1. Naviguer vers le dossier desktop-app:
```bash
cd desktop-app
```

2. Installer les dépendances:
```bash
npm install
```

## Développement

Pour lancer l'application en mode développement:
```bash
npm run dev
```

Cela va:
- Démarrer le serveur webpack sur http://localhost:9000
- Lancer Electron une fois le serveur prêt

## Build

Pour compiler l'application:
```bash
npm run build
```

Pour créer un exécutable:
```bash
npm run dist
```

## Structure du projet

```
antidetect-browser/
├── browser-core/        # Fork Chromium (à implémenter)
├── desktop-app/         # Application Electron principale
│   ├── src/
│   │   ├── main/       # Processus principal Electron
│   │   └── renderer/   # Interface React
│   └── dist/           # Fichiers compilés
├── api-server/         # API locale pour automatisation
├── profile-manager/    # Gestion avancée des profils
├── fingerprint-engine/ # Moteur de fingerprinting
├── automation-sdk/     # SDK pour automatisation
└── proxy-manager/      # Gestionnaire de proxies
```

## Fonctionnalités actuelles

- ✅ Création de profils avec nom personnalisé
- ✅ Configuration User Agent
- ✅ Configuration proxy (interface seulement)
- ✅ Sélection timezone
- ✅ Sélection langue
- ✅ Sélection résolution
- ✅ Liste des profils avec recherche
- ✅ Suppression de profils
- ✅ Interface moderne avec Tailwind CSS

## Prochaines étapes

1. Intégrer un fork de Chromium modifié
2. Implémenter l'isolation réelle des profils
3. Activer les modifications de fingerprint
4. Ajouter le support des proxies
5. Créer l'API locale pour l'automatisation
6. Implémenter la gestion avancée des empreintes digitales