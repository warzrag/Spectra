# URL Tracking for Profile Persistence

This antidetect browser now supports URL persistence - when you close a browser profile and reopen it later, it will restore the last visited URL.

## How it works

1. **Automatic URL Tracking Server**: When the desktop app starts, it launches a local server on port 45678 that listens for URL updates.

2. **Last URL Display**: Each profile card shows the last visited URL with a blue external link icon.

3. **URL Restoration**: When launching a profile, it automatically opens the last saved URL instead of Google accounts.

## Manual URL Tracking (Current Implementation)

Since Chrome is launched as a separate process, automatic URL tracking requires additional setup. Currently, URLs can be saved by:

### Option 1: Browser Extension (Recommended for automatic tracking)
1. Load the extension from `desktop-app/src/chrome-extension` in Chrome
2. The extension will automatically track URL changes and save them

### Option 2: Manual JavaScript Injection
You can inject this script into any page to save its URL:
```javascript
fetch('http://localhost:45678/api/save-url', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    profileId: 'YOUR_PROFILE_ID',
    url: window.location.href
  })
});
```

### Option 3: Bookmarklet
Create a bookmarklet with this code to quickly save the current page:
```javascript
javascript:(function(){fetch('http://localhost:45678/api/save-url',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profileId:prompt('Profile ID:'),url:window.location.href})}).then(()=>alert('URL saved!')).catch(e=>alert('Failed to save URL'))})();
```

## Future Improvements

- Automatic extension installation for each profile
- Native Chrome DevTools Protocol integration
- Real-time URL syncing
- URL history tracking

## Troubleshooting

- Make sure the desktop app is running (URL server runs on port 45678)
- Check that the profile ID is correct when saving URLs manually
- URLs starting with `chrome://` or `chrome-extension://` are ignored