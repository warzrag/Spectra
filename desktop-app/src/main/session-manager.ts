import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SessionData {
  profileId: string;
  urls: string[];
  activeTabIndex: number;
  timestamp: number;
  userAgent?: string;
  cookies?: any[];
  localStorage?: any;
}

export class SessionManager {
  private static sessionsDir = path.join(os.homedir(), '.antidetect-browser', 'sessions');

  static async saveSession(profileId: string, sessionData: Partial<SessionData>): Promise<void> {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }

    const sessionFile = path.join(this.sessionsDir, `${profileId}.json`);
    const existingData = await this.loadSession(profileId);
    
    const updatedSession: SessionData = {
      profileId,
      urls: sessionData.urls || existingData?.urls || [],
      activeTabIndex: sessionData.activeTabIndex || existingData?.activeTabIndex || 0,
      timestamp: Date.now(),
      userAgent: sessionData.userAgent || existingData?.userAgent,
      cookies: sessionData.cookies || existingData?.cookies || [],
      localStorage: sessionData.localStorage || existingData?.localStorage || {}
    };

    fs.writeFileSync(sessionFile, JSON.stringify(updatedSession, null, 2));
  }

  static async loadSession(profileId: string): Promise<SessionData | null> {
    const sessionFile = path.join(this.sessionsDir, `${profileId}.json`);
    
    if (!fs.existsSync(sessionFile)) {
      return null;
    }

    try {
      const data = fs.readFileSync(sessionFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Failed to load session:', error);
      return null;
    }
  }

  static async createSessionFile(profileId: string, initialUrl?: string): Promise<string> {
    const profileDir = path.join(os.homedir(), '.antidetect-browser', 'profiles', profileId);
    const sessionFilePath = path.join(profileDir, 'Default', 'Sessions');
    
    if (!fs.existsSync(path.dirname(sessionFilePath))) {
      fs.mkdirSync(path.dirname(sessionFilePath), { recursive: true });
    }

    // Create a Chrome-compatible session file
    const sessionData = {
      version: "1.0",
      timestamp: Date.now(),
      startupUrl: initialUrl || "https://www.google.com",
      tabs: [{
        url: initialUrl || "https://www.google.com",
        title: "New Tab",
        active: true,
        pinned: false
      }]
    };

    // Write session files that Chrome expects
    const tabsFile = path.join(profileDir, 'Default', 'Tabs_13');
    const currentTabsFile = path.join(profileDir, 'Default', 'Current Tabs_13');
    const lastTabsFile = path.join(profileDir, 'Default', 'Last Tabs_13');

    const tabsData = {
      sessions: [{
        windows: [{
          tabs: [{
            entries: [{
              url: initialUrl || "https://www.google.com",
              title: "New Tab"
            }],
            current_navigation_index: 0
          }],
          selected_tab_index: 0
        }]
      }]
    };

    try {
      // Write Chrome session files
      fs.writeFileSync(tabsFile, JSON.stringify(tabsData));
      fs.writeFileSync(currentTabsFile, JSON.stringify(tabsData));
      fs.writeFileSync(lastTabsFile, JSON.stringify(tabsData));
      
      console.log(`Created session files for profile ${profileId} with URL: ${initialUrl}`);
      return sessionFilePath;
    } catch (error) {
      console.error('Failed to create session file:', error);
      throw error;
    }
  }

  static async deleteSession(profileId: string): Promise<void> {
    const sessionFile = path.join(this.sessionsDir, `${profileId}.json`);
    
    if (fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
    }
  }

  static async listSessions(): Promise<string[]> {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    return fs.readdirSync(this.sessionsDir)
      .filter(file => file.endsWith('.json'))
      .map(file => file.replace('.json', ''));
  }
}