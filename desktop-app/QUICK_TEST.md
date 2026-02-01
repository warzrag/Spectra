# Test rapide de la persistance d'URL

## Pour tester la fonctionnalité :

1. **Lancez l'application**
```bash
cd desktop-app
npm run dev
```

2. **Créez ou sélectionnez un profil**

3. **Définissez une URL de démarrage**
   - Cliquez sur "Click to set start URL" sous le nom du profil
   - Ou cliquez sur l'icône crayon à côté de l'URL existante
   - Entrez l'URL désirée (ex: https://twitter.com)
   - Appuyez sur Entrée ou cliquez sur ✓

4. **Lancez le profil**
   - Cliquez sur "Launch"
   - Chrome devrait s'ouvrir avec l'URL définie

## Si ça ne fonctionne pas :

1. Vérifiez la console pour les logs :
   - "Launching profile: [ID]"
   - "Profile lastUrl: [URL]"
   - "Chrome launcher - Starting with URL: [URL]"

2. Si l'URL est undefined, éditez-la manuellement dans l'interface

3. Le serveur de tracking d'URL tourne sur le port 45678

## Pour sauvegarder l'URL actuelle d'un navigateur ouvert :

```bash
# Remplacez PROFILE_ID par l'ID réel du profil
node test-save-url.js PROFILE_ID https://twitter.com
```