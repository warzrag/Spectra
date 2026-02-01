# Debug de la persistance d'URL

## Problème actuel

Chrome redirige toujours vers Google accounts au lieu de l'URL sauvegardée.

## Solutions implémentées

### 1. Page de redirection HTML
- Chrome démarre maintenant avec une page HTML locale qui redirige vers l'URL cible
- Cela contourne les éventuelles restrictions de Chrome sur les URLs de démarrage

### 2. Extension Chrome (optionnelle)
- Une extension est chargée automatiquement pour tracker les changements d'URL
- L'extension envoie les URLs au serveur local (port 45678)

### 3. Configuration du profil
- Chaque profil a un fichier `antidetect-config.json` dans son répertoire
- Contient l'ID du profil et la dernière URL

## Comment tester

1. **Définir une URL pour un profil**
   - Cliquez sur l'icône crayon dans la carte du profil
   - Entrez une URL (ex: https://twitter.com)
   - Appuyez sur Entrée

2. **Vérifier les logs**
   Ouvrez la console développeur (Ctrl+Shift+I) et regardez :
   ```
   Launching profile: [ID]
   Profile lastUrl: [URL]
   Chrome launcher - Starting with redirect to: [URL]
   ```

3. **Lancer le profil**
   - Chrome devrait s'ouvrir avec une page de chargement
   - Puis rediriger automatiquement vers l'URL définie

## Si ça ne fonctionne toujours pas

1. **Vérifiez le stockage**
   ```bash
   # Windows
   dir %APPDATA%\antidetect-browser\profiles\[PROFILE_ID]\antidetect-config.json
   
   # Linux/Mac
   cat ~/.antidetect-browser/profiles/[PROFILE_ID]/antidetect-config.json
   ```

2. **Testez manuellement la sauvegarde d'URL**
   ```bash
   node test-save-url.js [PROFILE_ID] https://twitter.com
   ```

3. **Vérifiez que le serveur de tracking est actif**
   - Le serveur doit écouter sur le port 45678
   - Visible dans les logs au démarrage de l'app

## Solution alternative

Si Chrome continue de rediriger, vous pouvez :
1. Laisser Chrome s'ouvrir sur Google
2. Naviguer manuellement vers votre URL
3. La prochaine fois, l'URL sera sauvegardée (si l'extension fonctionne)

## Note importante

Chrome peut forcer la redirection vers Google accounts pour :
- Les nouveaux profils
- Les profils sans cookies Google
- Les profils avec des paramètres de sécurité spécifiques

Dans ces cas, la meilleure solution est de se connecter une première fois à Google, puis l'URL persistera correctement.