import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';

const execAsync = promisify(exec);

export interface NetworkConnection {
  id: string;
  name: string;
  type: 'wifi' | 'ethernet' | 'mobile' | 'usb';
  interface: string;
  currentIP?: string;
  isActive: boolean;
  icon: string;
}

export class NetworkManager {
  private static instance: NetworkManager;
  
  private constructor() {}
  
  static getInstance(): NetworkManager {
    if (!NetworkManager.instance) {
      NetworkManager.instance = new NetworkManager();
    }
    return NetworkManager.instance;
  }

  // Get all network interfaces
  async getNetworkConnections(): Promise<NetworkConnection[]> {
    const interfaces = os.networkInterfaces();
    const connections: NetworkConnection[] = [];
    
    for (const [name, addresses] of Object.entries(interfaces)) {
      if (!addresses) continue;
      
      // Find IPv4 address
      const ipv4 = addresses.find(addr => addr.family === 'IPv4' && !addr.internal);
      if (!ipv4) continue;
      
      // Determine connection type
      let type: 'wifi' | 'ethernet' | 'mobile' | 'usb' = 'ethernet';
      let connectionName = name;
      let icon = '🌐';
      
      if (name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wlan')) {
        type = 'wifi';
        connectionName = 'WiFi Home';
        icon = '📶';
      } else if (name.toLowerCase().includes('mobile') || name.toLowerCase().includes('cellular')) {
        type = 'mobile';
        connectionName = 'iPhone 4G';
        icon = '📱';
      } else if (name.toLowerCase().includes('usb') || name.toLowerCase().includes('rndis')) {
        // iPhone USB tethering often shows as RNDIS
        type = 'usb';
        connectionName = 'iPhone USB';
        icon = '📱';
      }
      
      connections.push({
        id: name,
        name: connectionName,
        type,
        interface: name,
        currentIP: ipv4.address,
        isActive: true,
        icon
      });
    }
    
    return connections;
  }

  // Get current external IP
  async getCurrentIP(): Promise<string> {
    try {
      const response = await axios.get('https://api.ipify.org?format=json', {
        timeout: 5000
      });
      return response.data.ip;
    } catch (error) {
      console.error('Failed to get external IP:', error);
      return 'Unknown';
    }
  }

  // Check which network interface is being used
  async getActiveConnection(): Promise<NetworkConnection | null> {
    const connections = await this.getNetworkConnections();
    
    // On Windows, we can check the default gateway
    if (process.platform === 'win32') {
      try {
        const { stdout } = await execAsync('route print 0.0.0.0');
        // Parse the output to find the active interface
        // This is simplified - you might need more robust parsing
        for (const conn of connections) {
          if (stdout.includes(conn.currentIP || '')) {
            return conn;
          }
        }
      } catch (error) {
        console.error('Failed to get route info:', error);
      }
    }
    
    // For other platforms or as fallback, return the first connection
    return connections[0] || null;
  }

  // Instructions for setting up iPhone hotspot
  getHotspotInstructions(): string {
    return `
Pour utiliser votre iPhone 4G comme connexion:

1. **Hotspot WiFi** (Recommandé):
   - Sur iPhone: Réglages > Partage de connexion
   - Activez "Autoriser d'autres utilisateurs"
   - Connectez votre PC au WiFi de l'iPhone
   - L'IP changera à chaque activation du hotspot

2. **USB Tethering**:
   - Connectez l'iPhone par USB
   - Sur iPhone: Réglages > Partage de connexion
   - Activez "Partage de connexion"
   - Windows détectera automatiquement la connexion

3. **Rotation d'IP**:
   - Mode Avion ON/OFF sur l'iPhone = Nouvelle IP
   - Désactiver/Réactiver le partage = Nouvelle IP
   - Changer de tour cellulaire = Nouvelle IP

Note: Chaque profil peut utiliser une connexion différente!
`;
  }

  // Simple connection switcher for profiles
  async assignConnectionToProfile(profileId: string, connectionId: string): Promise<void> {
    // In a real implementation, you would:
    // 1. Store the mapping of profile -> connection
    // 2. Use system commands to route traffic through specific interfaces
    // For now, we'll just log the assignment
    console.log(`Profile ${profileId} assigned to connection ${connectionId}`);
    
    // Note: Actual network routing per application is complex and requires:
    // - On Windows: WinDivert or similar
    // - On macOS/Linux: iptables rules or network namespaces
    // - Or use a proper proxy solution
  }

  // Get connection info for display
  async getConnectionInfo(connectionId: string): Promise<{
    name: string;
    ip: string;
    type: string;
  } | null> {
    const connections = await this.getNetworkConnections();
    const connection = connections.find(c => c.id === connectionId);
    
    if (!connection) return null;
    
    const externalIP = await this.getCurrentIP();
    
    return {
      name: connection.name,
      ip: externalIP,
      type: connection.type
    };
  }

  // Monitor connection changes
  startConnectionMonitoring(callback: (connections: NetworkConnection[]) => void): void {
    // Check for connection changes every 5 seconds
    setInterval(async () => {
      const connections = await this.getNetworkConnections();
      callback(connections);
    }, 5000);
  }
}

export default NetworkManager;