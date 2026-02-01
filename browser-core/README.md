# Browser Core Module

Ce module contient l'intégration avec Chromium et le système de lancement de navigateurs avec des fingerprints personnalisés.

## Structure

```
browser-core/
├── launcher/           # Lanceur de navigateur principal
├── patches/           # Patches Chromium (à implémenter)
├── injector/          # Injection de fingerprints
└── profiles/          # Gestion des profils de navigateur
```

## Fonctionnalités

### 1. Lanceur de navigateur
- Lance des instances Chromium isolées
- Injecte les paramètres de fingerprint
- Configure les proxies
- Gère les profils de données

### 2. Injection de fingerprints
- Modifie les propriétés JavaScript du navigateur
- Override les APIs WebRTC, Canvas, WebGL
- Gère les fuseaux horaires et langues
- Configure la résolution d'écran

### 3. Isolation des profils
- Chaque profil a son propre répertoire de données
- Isolation complète des cookies et localStorage
- Sessions indépendantes
- Support multi-comptes

## Installation

```bash
npm install
```

## Utilisation

```javascript
const { BrowserLauncher } = require('./launcher');

const launcher = new BrowserLauncher();
const browser = await launcher.launch({
  profileId: '123',
  fingerprint: { /* ... */ },
  proxy: { /* ... */ }
});
```

## TODO

1. Intégrer un fork de Chromium modifié
2. Implémenter les patches C++ pour le fingerprinting
3. Créer un système de mise à jour automatique
4. Ajouter le support des extensions