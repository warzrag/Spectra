import * as crypto from 'crypto';
import axios from 'axios';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface ProxyConfig {
  id?: string;
  name?: string;
  type: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
  sessionId?: string;
  provider?: 'brightdata' | 'smartproxy' | 'iproyal' | 'oxylabs' | 'custom';
  rotation?: {
    type: 'sticky' | 'rotating';
    duration?: number; // seconds for sticky sessions
  };
  country?: string;
  city?: string;
  lastUsed?: Date;
  isHealthy?: boolean;
  lastCheck?: Date;
}

export interface ProxyStats {
  profileId: string;
  proxyId: string;
  bytesUsed: number;
  requestCount: number;
  lastIp?: string;
  lastLocation?: string;
  errors: number;
  avgResponseTime?: number;
}

export class ProxyManager {
  private static instance: ProxyManager;
  private proxyPool: Map<string, ProxyConfig> = new Map();
  private proxyStats: Map<string, ProxyStats> = new Map();
  private profileProxyMap: Map<string, string> = new Map(); // profileId -> proxyId
  private proxyDataPath: string;
  private encryptionKey: Buffer;

  private constructor() {
    this.proxyDataPath = path.join(app.getPath('userData'), 'proxy-data');
    if (!fs.existsSync(this.proxyDataPath)) {
      fs.mkdirSync(this.proxyDataPath, { recursive: true });
    }
    
    // Generate or load encryption key
    this.encryptionKey = this.getOrCreateEncryptionKey();
    
    // Load existing proxy data
    this.loadProxyData();
  }

  static getInstance(): ProxyManager {
    if (!ProxyManager.instance) {
      ProxyManager.instance = new ProxyManager();
    }
    return ProxyManager.instance;
  }

  private getOrCreateEncryptionKey(): Buffer {
    const keyPath = path.join(this.proxyDataPath, '.key');
    
    if (fs.existsSync(keyPath)) {
      return fs.readFileSync(keyPath);
    }
    
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key);
    return key;
  }

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  private decrypt(text: string): string {
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift()!, 'hex');
    const encrypted = parts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  private saveProxyData(): void {
    const data = {
      proxies: Array.from(this.proxyPool.entries()).map(([id, proxy]) => ({
        ...proxy,
        id,
        password: proxy.password ? this.encrypt(proxy.password) : undefined,
      })),
      stats: Array.from(this.proxyStats.entries()),
      mapping: Array.from(this.profileProxyMap.entries()),
    };
    
    fs.writeFileSync(
      path.join(this.proxyDataPath, 'proxies.json'),
      JSON.stringify(data, null, 2)
    );
  }

  private loadProxyData(): void {
    const dataPath = path.join(this.proxyDataPath, 'proxies.json');
    
    if (!fs.existsSync(dataPath)) {
      return;
    }
    
    try {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      
      // Load proxies
      if (data.proxies) {
        data.proxies.forEach((proxy: any) => {
          if (proxy.password) {
            proxy.password = this.decrypt(proxy.password);
          }
          this.proxyPool.set(proxy.id || crypto.randomBytes(8).toString('hex'), proxy);
        });
      }
      
      // Load stats
      if (data.stats) {
        data.stats.forEach(([key, value]: [string, ProxyStats]) => {
          this.proxyStats.set(key, value);
        });
      }
      
      // Load mappings
      if (data.mapping) {
        data.mapping.forEach(([profileId, proxyId]: [string, string]) => {
          this.profileProxyMap.set(profileId, proxyId);
        });
      }
    } catch (error) {
      console.error('Failed to load proxy data:', error);
    }
  }

  // Add a new proxy to the pool
  async addProxy(proxy: ProxyConfig): Promise<string> {
    const proxyId = proxy.id || crypto.randomBytes(8).toString('hex');
    
    // Test proxy before adding
    const isHealthy = await this.testProxy(proxy);
    
    this.proxyPool.set(proxyId, {
      ...proxy,
      id: proxyId,
      isHealthy,
      lastCheck: new Date(),
    });
    
    this.saveProxyData();
    return proxyId;
  }

  // Add multiple proxies from text input (bulk import)
  async addProxiesFromText(text: string): Promise<number> {
    const lines = text.split('\n').filter(line => line.trim());
    let added = 0;
    
    for (const line of lines) {
      try {
        const proxy = this.parseProxyString(line.trim());
        if (proxy) {
          await this.addProxy(proxy);
          added++;
        }
      } catch (error) {
        console.error('Failed to parse proxy:', line, error);
      }
    }
    
    return added;
  }

  // Parse proxy string in various formats
  private parseProxyString(proxyStr: string): ProxyConfig | null {
    // Format: protocol://username:password@host:port
    const regex = /^(https?|socks5):\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/i;
    const match = proxyStr.match(regex);
    
    if (match) {
      return {
        type: match[1].toLowerCase() as 'http' | 'https' | 'socks5',
        username: match[2],
        password: match[3],
        host: match[4],
        port: parseInt(match[5], 10),
      };
    }
    
    // Alternative format: host:port:username:password
    const parts = proxyStr.split(':');
    if (parts.length >= 2) {
      return {
        type: 'http',
        host: parts[0],
        port: parseInt(parts[1], 10),
        username: parts[2],
        password: parts[3],
      };
    }
    
    return null;
  }

  // Test proxy connectivity
  async testProxy(proxy: ProxyConfig): Promise<boolean> {
    const testUrls = [
      'https://httpbin.org/ip',
      'https://api.ipify.org?format=json',
    ];
    
    try {
      const axiosConfig: any = {
        timeout: 10000,
        proxy: {
          protocol: proxy.type,
          host: proxy.host,
          port: proxy.port,
        },
      };
      
      if (proxy.username && proxy.password) {
        axiosConfig.proxy.auth = {
          username: proxy.username,
          password: proxy.password,
        };
      }
      
      const response = await axios.get(testUrls[0], axiosConfig);
      return response.status === 200;
    } catch (error) {
      console.error('Proxy test failed:', error);
      return false;
    }
  }

  // Get proxy for a profile
  async getProxyForProfile(profileId: string): Promise<ProxyConfig | null> {
    const proxyId = this.profileProxyMap.get(profileId);
    
    if (proxyId) {
      return this.proxyPool.get(proxyId) || null;
    }
    
    // Auto-assign from pool if no proxy assigned
    const healthyProxy = await this.getHealthyProxy();
    if (healthyProxy) {
      this.assignProxyToProfile(profileId, healthyProxy.id!);
      return healthyProxy;
    }
    
    return null;
  }

  // Assign specific proxy to profile
  assignProxyToProfile(profileId: string, proxyId: string): void {
    this.profileProxyMap.set(profileId, proxyId);
    this.saveProxyData();
  }

  // Get a healthy proxy from pool
  private async getHealthyProxy(): Promise<ProxyConfig | null> {
    const proxies = Array.from(this.proxyPool.values());
    
    // First try to find already healthy proxies
    const healthyProxies = proxies.filter(p => p.isHealthy);
    if (healthyProxies.length > 0) {
      return healthyProxies[Math.floor(Math.random() * healthyProxies.length)];
    }
    
    // Test all proxies to find a working one
    for (const proxy of proxies) {
      const isHealthy = await this.testProxy(proxy);
      proxy.isHealthy = isHealthy;
      proxy.lastCheck = new Date();
      
      if (isHealthy) {
        this.saveProxyData();
        return proxy;
      }
    }
    
    return null;
  }

  // Rotate proxy for a profile
  async rotateProxy(profileId: string): Promise<ProxyConfig | null> {
    const currentProxyId = this.profileProxyMap.get(profileId);
    
    // Get all healthy proxies except current one
    const availableProxies = Array.from(this.proxyPool.values())
      .filter(p => p.id !== currentProxyId && p.isHealthy);
    
    if (availableProxies.length === 0) {
      // No other healthy proxies available
      return null;
    }
    
    // Select random proxy from available ones
    const newProxy = availableProxies[Math.floor(Math.random() * availableProxies.length)];
    this.assignProxyToProfile(profileId, newProxy.id!);
    
    return newProxy;
  }

  // Update proxy stats
  updateStats(profileId: string, update: Partial<ProxyStats>): void {
    const proxyId = this.profileProxyMap.get(profileId);
    if (!proxyId) return;
    
    const statsKey = `${profileId}-${proxyId}`;
    const existing = this.proxyStats.get(statsKey) || {
      profileId,
      proxyId,
      bytesUsed: 0,
      requestCount: 0,
      errors: 0,
    };
    
    this.proxyStats.set(statsKey, { ...existing, ...update });
    this.saveProxyData();
  }

  // Get all proxies
  getAllProxies(): ProxyConfig[] {
    return Array.from(this.proxyPool.values());
  }

  // Remove proxy
  removeProxy(proxyId: string): void {
    this.proxyPool.delete(proxyId);
    
    // Remove any profile assignments
    for (const [profileId, assignedProxyId] of this.profileProxyMap.entries()) {
      if (assignedProxyId === proxyId) {
        this.profileProxyMap.delete(profileId);
      }
    }
    
    this.saveProxyData();
  }

  // Get proxy string for Chrome
  getProxyString(proxy: ProxyConfig): string {
    let proxyStr = `${proxy.type}://${proxy.host}:${proxy.port}`;
    
    if (proxy.username && proxy.password) {
      // Note: Chrome doesn't support inline auth for proxies
      // We'll need to handle auth differently
      return proxyStr;
    }
    
    return proxyStr;
  }

  // Provider-specific configurations
  formatProviderProxy(proxy: ProxyConfig): ProxyConfig {
    switch (proxy.provider) {
      case 'brightdata':
        // Bright Data specific formatting
        if (proxy.sessionId) {
          proxy.username = `${proxy.username}-session-${proxy.sessionId}`;
        }
        if (proxy.country) {
          proxy.username = `${proxy.username}-country-${proxy.country}`;
        }
        break;
        
      case 'smartproxy':
        // Smartproxy specific formatting
        if (proxy.sessionId) {
          proxy.username = `${proxy.username}_session-${proxy.sessionId}`;
        }
        break;
        
      case 'iproyal':
        // IPRoyal specific formatting
        if (proxy.rotation?.type === 'sticky' && proxy.rotation.duration) {
          proxy.username = `${proxy.username}_lifetime-${proxy.rotation.duration}`;
        }
        break;
    }
    
    return proxy;
  }

  // Health check all proxies
  async healthCheckAll(): Promise<void> {
    const proxies = Array.from(this.proxyPool.values());
    
    for (const proxy of proxies) {
      const isHealthy = await this.testProxy(proxy);
      proxy.isHealthy = isHealthy;
      proxy.lastCheck = new Date();
    }
    
    this.saveProxyData();
  }

  // Get proxy statistics
  getStats(profileId?: string): ProxyStats[] {
    if (profileId) {
      return Array.from(this.proxyStats.values())
        .filter(stat => stat.profileId === profileId);
    }
    
    return Array.from(this.proxyStats.values());
  }
}

export default ProxyManager;