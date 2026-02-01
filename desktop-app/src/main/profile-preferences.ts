import * as fs from 'fs';
import * as path from 'path';

export class ProfilePreferences {
  static setupChromePreferences(profilePath: string, lastUrl?: string): void {
    const prefsPath = path.join(profilePath, 'Default', 'Preferences');
    const prefsDir = path.dirname(prefsPath);
    
    // Ensure directory exists
    if (!fs.existsSync(prefsDir)) {
      fs.mkdirSync(prefsDir, { recursive: true });
    }
    
    let prefs: any = {};
    
    // Load existing preferences if they exist
    if (fs.existsSync(prefsPath)) {
      try {
        const existingPrefs = fs.readFileSync(prefsPath, 'utf8');
        prefs = JSON.parse(existingPrefs);
      } catch (error) {
        console.error('Failed to parse existing preferences:', error);
      }
    }
    
    // Set session restoration preferences
    prefs.session = prefs.session || {};
    prefs.session.restore_on_startup = 1; // 1 = Restore last session
    prefs.session.startup_urls = lastUrl ? [lastUrl] : [];
    
    // Set profile preferences
    prefs.profile = prefs.profile || {};
    prefs.profile.exit_type = 'Normal';
    prefs.profile.exited_cleanly = true;
    
    // Disable annoying popups and redirects
    prefs.browser = prefs.browser || {};
    prefs.browser.show_home_button = false;
    prefs.browser.check_default_browser = false;
    
    // Disable sign-in and sync prompts
    prefs.signin = prefs.signin || {};
    prefs.signin.allowed = false;
    prefs.sync_promo = prefs.sync_promo || {};
    prefs.sync_promo.show_on_first_run_allowed = false;
    
    // Privacy settings
    prefs.safebrowsing = prefs.safebrowsing || {};
    prefs.safebrowsing.enabled = false;
    prefs.safebrowsing.enhanced = false;
    
    // Write preferences
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
    console.log('Chrome preferences configured for profile:', profilePath);
  }
  
  static createLocalState(profilesDir: string): void {
    const localStatePath = path.join(profilesDir, 'Local State');
    
    const localState = {
      "browser": {
        "enabled_labs_experiments": [],
        "last_redirect_origin": ""
      },
      "hardware_acceleration_mode": {
        "enabled": false
      },
      "profile": {
        "info_cache": {},
        "last_used": "Default",
        "last_active_profiles": ["Default"]
      }
    };
    
    fs.writeFileSync(localStatePath, JSON.stringify(localState, null, 2));
  }
}