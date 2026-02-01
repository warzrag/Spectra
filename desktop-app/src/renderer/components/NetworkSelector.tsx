import React, { useState, useEffect } from 'react';
import { Wifi, Smartphone, Globe, AlertCircle, RefreshCw } from 'lucide-react';

interface NetworkSelectorProps {
  value?: string;
  onChange: (connectionId: string) => void;
}

interface NetworkConnection {
  id: string;
  name: string;
  type: 'wifi' | 'ethernet' | 'mobile' | 'usb';
  currentIP?: string;
  icon: string;
}

const NetworkSelector: React.FC<NetworkSelectorProps> = ({ value, onChange }) => {
  const [connections, setConnections] = useState<NetworkConnection[]>([]);
  const [currentIP, setCurrentIP] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [showInstructions, setShowInstructions] = useState(false);

  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    try {
      if (window.electronAPI && window.electronAPI.network) {
        const conns = await window.electronAPI.network.getConnections();
        setConnections(conns);
        
        const ip = await window.electronAPI.network.getCurrentIP();
        setCurrentIP(ip);
      }
    } catch (error) {
      console.error('Failed to load connections:', error);
    } finally {
      setLoading(false);
    }
  };

  const getConnectionIcon = (type: string) => {
    switch (type) {
      case 'wifi':
        return <Wifi size={16} />;
      case 'mobile':
      case 'usb':
        return <Smartphone size={16} />;
      default:
        return <Globe size={16} />;
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
          <Globe size={16} />
          Network Connection
        </label>
        <button
          type="button"
          onClick={() => setShowInstructions(!showInstructions)}
          className="text-sm text-blue-400 hover:text-blue-300"
        >
          How to use iPhone 4G?
        </button>
      </div>

      {showInstructions && (
        <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 text-sm">
          <h4 className="font-medium text-gray-200 mb-2 flex items-center gap-2">
            <Smartphone size={16} />
            Using iPhone 4G for Different IPs
          </h4>
          <div className="text-gray-400 space-y-2">
            <p><strong>WiFi Hotspot (Recommended):</strong></p>
            <ol className="list-decimal list-inside space-y-1 ml-2">
              <li>iPhone: Settings → Personal Hotspot → ON</li>
              <li>Connect your PC to iPhone's WiFi</li>
              <li>Each instance can use different connection!</li>
            </ol>
            
            <p className="mt-3"><strong>Get New IP:</strong></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>Toggle Airplane Mode ON/OFF</li>
              <li>Restart Personal Hotspot</li>
              <li>Move to different location (new cell tower)</li>
            </ul>
            
            <div className="mt-3 p-2 bg-yellow-900/20 border border-yellow-700 rounded text-yellow-300">
              <AlertCircle size={14} className="inline mr-1" />
              Note: Actual per-app routing requires system-level proxy
            </div>
          </div>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-400 mb-2">
          Select Network
        </label>
        {loading ? (
          <div className="flex items-center justify-center py-4 text-gray-500">
            <RefreshCw size={16} className="animate-spin mr-2" />
            Loading connections...
          </div>
        ) : connections.length === 0 ? (
          <div className="text-gray-500 text-sm">
            No network connections found
          </div>
        ) : (
          <select
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
          >
            <option value="">Default System Connection</option>
            {connections.map((conn) => (
              <option key={conn.id} value={conn.id}>
                {conn.icon} {conn.name} - {conn.currentIP || 'No IP'}
              </option>
            ))}
          </select>
        )}
      </div>

      {currentIP && (
        <div className="text-sm text-gray-400">
          Current External IP: <span className="text-white font-mono">{currentIP}</span>
        </div>
      )}

      <div className="bg-blue-900/20 border border-blue-700 rounded-lg p-3 text-sm text-blue-300">
        <strong>Tip:</strong> For true IP isolation per instance, consider using:
        <ul className="list-disc list-inside mt-1 ml-2">
          <li>Residential proxy services (recommended)</li>
          <li>VPN with multi-hop support</li>
          <li>Multiple 4G USB modems</li>
        </ul>
      </div>
    </div>
  );
};

export default NetworkSelector;