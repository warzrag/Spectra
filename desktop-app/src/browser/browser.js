// In Electron context, we have access to window.require
const ipcRenderer = window.require ? window.require('electron').ipcRenderer : null;

const webview = document.getElementById('webview');
const urlBar = document.getElementById('url-bar');
const backBtn = document.getElementById('back-btn');
const forwardBtn = document.getElementById('forward-btn');
const reloadBtn = document.getElementById('reload-btn');
const homeBtn = document.getElementById('home-btn');
const loadingBar = document.getElementById('loading-bar');

// Get initial data from main process
let profileData = null;
let profileId = null;

// Initialize webview with profile data
window.addEventListener('DOMContentLoaded', () => {
    // Get profile data from URL params
    const urlParams = new URLSearchParams(window.location.search);
    profileId = urlParams.get('profileId');
    const profileDataStr = urlParams.get('profileData');
    
    if (profileDataStr) {
        profileData = JSON.parse(decodeURIComponent(profileDataStr));
        initializeWebview();
    }
});

function initializeWebview() {
    // Set webview attributes
    webview.setAttribute('partition', `persist:profile-${profileId}`);
    webview.setAttribute('useragent', profileData.userAgent || navigator.userAgent);
    
    // Load initial URL
    const initialUrl = profileData.lastUrl || 'https://www.google.com';
    webview.src = initialUrl;
    urlBar.value = initialUrl;
}

// Navigation controls
backBtn.addEventListener('click', () => {
    if (webview.canGoBack()) {
        webview.goBack();
    }
});

forwardBtn.addEventListener('click', () => {
    if (webview.canGoForward()) {
        webview.goForward();
    }
});

reloadBtn.addEventListener('click', () => {
    webview.reload();
});

homeBtn.addEventListener('click', () => {
    webview.src = 'https://www.google.com';
});

// URL bar
urlBar.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        let url = urlBar.value.trim();
        
        // Add protocol if missing
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            // Check if it looks like a domain
            if (url.includes('.') && !url.includes(' ')) {
                url = 'https://' + url;
            } else {
                // Treat as search query
                url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
            }
        }
        
        webview.src = url;
    }
});

// Webview events
webview.addEventListener('did-start-loading', () => {
    loadingBar.style.width = '30%';
    loadingBar.classList.add('loading');
});

webview.addEventListener('did-stop-loading', () => {
    loadingBar.style.width = '100%';
    setTimeout(() => {
        loadingBar.classList.remove('loading');
        loadingBar.style.width = '0%';
    }, 200);
});

webview.addEventListener('did-navigate', (event) => {
    urlBar.value = event.url;
    updateNavigationButtons();
    saveCurrentUrl(event.url);
});

webview.addEventListener('did-navigate-in-page', (event) => {
    urlBar.value = event.url;
    updateNavigationButtons();
    saveCurrentUrl(event.url);
});

webview.addEventListener('did-finish-load', () => {
    const currentUrl = webview.getURL();
    urlBar.value = currentUrl;
    updateNavigationButtons();
    saveCurrentUrl(currentUrl);
});

webview.addEventListener('new-window', (event) => {
    // Handle new window requests (e.g., target="_blank")
    event.preventDefault();
    webview.src = event.url;
});

webview.addEventListener('page-title-updated', (event) => {
    document.title = event.title + ' - Profile: ' + profileData.name;
});

// Update navigation button states
function updateNavigationButtons() {
    backBtn.disabled = !webview.canGoBack();
    forwardBtn.disabled = !webview.canGoForward();
}

// Save current URL to profile
function saveCurrentUrl(url) {
    if (url && !url.startsWith('devtools://')) {
        if (window.electronAPI && window.electronAPI.saveUrl) {
            window.electronAPI.saveUrl(profileId, url);
        } else if (ipcRenderer) {
            ipcRenderer.send('browser:save-url', profileId, url);
        }
    }
}

// Handle window close
window.addEventListener('beforeunload', () => {
    const currentUrl = webview.getURL();
    saveCurrentUrl(currentUrl);
});