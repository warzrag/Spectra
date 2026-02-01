import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import CryptoJS from 'crypto-js';

export interface Profile {
  id: string;
  name: string;
  fingerprint: ProfileFingerprint;
  proxy?: ProxyConfig;
  notes?: string;
  tags?: string[];
  createdAt: Date;
  lastUsed?: Date;
  status: 'active' | 'inactive';
}

export interface ProfileFingerprint {
  userAgent: string;
  platform: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  screenResolution: string;
  colorDepth: number;
  timezone: string;
  language: string;
  languages: string[];
  webglVendor: string;
  webglRenderer: string;
  canvas: string;
  audioContext: string;
  fonts: string[];
  plugins: any[];
  battery?: BatteryConfig;
  webrtc: WebRTCConfig;
}

export interface ProxyConfig {
  type: 'http' | 'socks5' | 'socks4';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface BatteryConfig {
  charging: boolean;
  level: number;
  chargingTime: number;
  dischargingTime: number;
}

export interface WebRTCConfig {
  publicIP?: string;
  localIPs: string[];
  mode: 'real' | 'fake' | 'disabled';
}

class ProfileDatabase {
  private db: sqlite3.Database;
  private encryptionKey: string;

  constructor(dbPath: string, encryptionKey: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new sqlite3.Database(dbPath);
    this.encryptionKey = encryptionKey;
    this.initDatabase();
  }

  private async initDatabase() {
    const run = promisify(this.db.run.bind(this.db));

    await run(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        proxy TEXT,
        notes TEXT,
        tags TEXT,
        created_at TEXT NOT NULL,
        last_used TEXT,
        status TEXT NOT NULL
      )
    `);

    await run(`
      CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
    `);

    await run(`
      CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS profile_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        action TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        details TEXT,
        FOREIGN KEY (profile_id) REFERENCES profiles(id)
      )
    `);
  }

  private encrypt(data: any): string {
    const jsonStr = JSON.stringify(data);
    return CryptoJS.AES.encrypt(jsonStr, this.encryptionKey).toString();
  }

  private decrypt(encryptedData: string): any {
    const bytes = CryptoJS.AES.decrypt(encryptedData, this.encryptionKey);
    const jsonStr = bytes.toString(CryptoJS.enc.Utf8);
    return JSON.parse(jsonStr);
  }

  async createProfile(profile: Profile): Promise<Profile> {
    const run = promisify(this.db.run.bind(this.db));
    
    const encryptedFingerprint = this.encrypt(profile.fingerprint);
    const encryptedProxy = profile.proxy ? this.encrypt(profile.proxy) : null;
    
    await run(
      `INSERT INTO profiles (id, name, fingerprint, proxy, notes, tags, created_at, last_used, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        profile.id,
        profile.name,
        encryptedFingerprint,
        encryptedProxy,
        profile.notes || null,
        profile.tags ? JSON.stringify(profile.tags) : null,
        profile.createdAt.toISOString(),
        profile.lastUsed ? profile.lastUsed.toISOString() : null,
        profile.status
      ]
    );

    await this.addHistory(profile.id, 'created', { name: profile.name });

    return profile;
  }

  async getProfile(id: string): Promise<Profile | null> {
    const get = promisify(this.db.get.bind(this.db));
    
    const row = await get('SELECT * FROM profiles WHERE id = ?', [id]);
    
    if (!row) return null;

    return this.rowToProfile(row);
  }

  async getAllProfiles(): Promise<Profile[]> {
    const all = promisify(this.db.all.bind(this.db));
    
    const rows = await all('SELECT * FROM profiles ORDER BY created_at DESC');
    
    return rows.map(row => this.rowToProfile(row));
  }

  async updateProfile(id: string, updates: Partial<Profile>): Promise<boolean> {
    const run = promisify(this.db.run.bind(this.db));
    const profile = await this.getProfile(id);
    
    if (!profile) return false;

    const updatedProfile = { ...profile, ...updates };
    const encryptedFingerprint = this.encrypt(updatedProfile.fingerprint);
    const encryptedProxy = updatedProfile.proxy ? this.encrypt(updatedProfile.proxy) : null;

    await run(
      `UPDATE profiles 
       SET name = ?, fingerprint = ?, proxy = ?, notes = ?, tags = ?, last_used = ?, status = ?
       WHERE id = ?`,
      [
        updatedProfile.name,
        encryptedFingerprint,
        encryptedProxy,
        updatedProfile.notes || null,
        updatedProfile.tags ? JSON.stringify(updatedProfile.tags) : null,
        updatedProfile.lastUsed ? updatedProfile.lastUsed.toISOString() : null,
        updatedProfile.status,
        id
      ]
    );

    await this.addHistory(id, 'updated', updates);

    return true;
  }

  async deleteProfile(id: string): Promise<boolean> {
    const run = promisify(this.db.run.bind(this.db));
    
    await this.addHistory(id, 'deleted', {});
    await run('DELETE FROM profiles WHERE id = ?', [id]);

    return true;
  }

  async searchProfiles(query: string): Promise<Profile[]> {
    const all = promisify(this.db.all.bind(this.db));
    
    const rows = await all(
      'SELECT * FROM profiles WHERE name LIKE ? OR notes LIKE ? ORDER BY created_at DESC',
      [`%${query}%`, `%${query}%`]
    );

    return rows.map(row => this.rowToProfile(row));
  }

  async updateLastUsed(id: string): Promise<void> {
    const run = promisify(this.db.run.bind(this.db));
    
    await run(
      'UPDATE profiles SET last_used = ? WHERE id = ?',
      [new Date().toISOString(), id]
    );

    await this.addHistory(id, 'launched', {});
  }

  private rowToProfile(row: any): Profile {
    return {
      id: row.id,
      name: row.name,
      fingerprint: this.decrypt(row.fingerprint),
      proxy: row.proxy ? this.decrypt(row.proxy) : undefined,
      notes: row.notes,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      createdAt: new Date(row.created_at),
      lastUsed: row.last_used ? new Date(row.last_used) : undefined,
      status: row.status
    };
  }

  private async addHistory(profileId: string, action: string, details: any): Promise<void> {
    const run = promisify(this.db.run.bind(this.db));
    
    await run(
      'INSERT INTO profile_history (profile_id, action, timestamp, details) VALUES (?, ?, ?, ?)',
      [profileId, action, new Date().toISOString(), JSON.stringify(details)]
    );
  }

  close(): void {
    this.db.close();
  }
}

export default ProfileDatabase;