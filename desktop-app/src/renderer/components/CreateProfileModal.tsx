import React, { useState, useEffect } from 'react';
import { X, Wand2, ChevronDown, Monitor, Globe, Fingerprint, Settings2, Tag as TagIcon, Loader2, Check, Shuffle } from 'lucide-react';
import { Folder as FolderType, Platform, Profile, ProfileStatus } from '../../types';
import ConnectionSelector from './ConnectionSelector';

interface CreateProfileModalProps {
  onClose: () => void;
  onCreate: (profileData: any) => void;
  onUpdate?: (profileId: string, profileData: any) => void;
  folders?: FolderType[];
  defaultFolderId?: string | null;
  editProfile?: Profile | null;
}

interface ProfilePreset {
  name: string;
  description: string;
  category: string;
  fingerprint: any;
}

type TabId = 'general' | 'proxy' | 'fingerprint' | 'advanced';

const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'general', label: 'General', icon: <Monitor size={15} /> },
  { id: 'proxy', label: 'Proxy', icon: <Globe size={15} /> },
  { id: 'fingerprint', label: 'Fingerprint', icon: <Fingerprint size={15} /> },
  { id: 'advanced', label: 'Advanced', icon: <Settings2 size={15} /> },
];

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
};

const labelStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
};

const CreateProfileModal: React.FC<CreateProfileModalProps> = ({ onClose, onCreate, onUpdate, folders = [], defaultFolderId, editProfile }) => {
  const isEditMode = !!editProfile;
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [profileName, setProfileName] = useState(editProfile?.name || '');
  const [userAgent, setUserAgent] = useState(editProfile?.userAgent || '');
  const [connectionConfig, setConnectionConfig] = useState<any>(editProfile?.connectionConfig || { type: editProfile?.connectionType || 'system', proxy: editProfile?.proxy });
  const [timezone, setTimezone] = useState(editProfile?.timezone || '');
  const [language, setLanguage] = useState(editProfile?.language || 'en-US');
  const [resolution, setResolution] = useState(editProfile?.screenResolution || '1920x1080');
  const [presets, setPresets] = useState<ProfilePreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>(editProfile?.preset || '');
  const [fingerprint, setFingerprint] = useState<any>(editProfile?.fingerprint || null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(editProfile?.folderId || defaultFolderId || null);
  const [platform, setPlatform] = useState<Platform | ''>(editProfile?.platform || '');
  const [hardwareConcurrency, setHardwareConcurrency] = useState(editProfile?.hardwareConcurrency || 8);
  const [deviceMemory, setDeviceMemory] = useState(editProfile?.deviceMemory || 8);
  const [webglVendor, setWebglVendor] = useState(editProfile?.webglVendor || 'Google Inc.');
  const [webglRenderer, setWebglRenderer] = useState(editProfile?.webglRenderer || 'ANGLE (Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0)');
  const [os, setOs] = useState<'windows' | 'macos' | 'linux'>(editProfile?.os || 'windows');
  const [browserType, setBrowserType] = useState<'chrome' | 'firefox' | 'edge'>(editProfile?.browserType || 'chrome');
  const [tags, setTags] = useState<string[]>(editProfile?.tags || []);
  const [tagInput, setTagInput] = useState('');
  const [notes, setNotes] = useState(editProfile?.notes || '');
  const [status, setStatus] = useState<ProfileStatus>(editProfile?.status || 'none');
  const [canvasNoise, setCanvasNoise] = useState(editProfile?.fingerprint?.canvasNoise ?? true);
  const [audioNoise, setAudioNoise] = useState(editProfile?.fingerprint?.audioNoise ?? true);
  const [webrtcMode, setWebrtcMode] = useState<'real' | 'disabled' | 'fake'>(editProfile?.fingerprint?.webrtcMode || 'fake');
  const [doNotTrack, setDoNotTrack] = useState(editProfile?.fingerprint?.doNotTrack ?? false);
  const [cookieImport, setCookieImport] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [showCountryPicker, setShowCountryPicker] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      const input = document.querySelector('input[name="profileName"]') as HTMLInputElement;
      if (input) input.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  const userAgents: Record<string, { name: string; value: string }[]> = {
    chrome: [
      { name: 'Chrome 140 Windows', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.82 Safari/537.36' },
      { name: 'Chrome 140 Mac', value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.82 Safari/537.36' },
      { name: 'Chrome 140 Linux', value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.82 Safari/537.36' },
      { name: 'Chrome 139 Windows', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.7258.94 Safari/537.36' },
    ],
    firefox: [
      { name: 'Firefox 130 Windows', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0' },
      { name: 'Firefox 130 Mac', value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0' },
    ],
    edge: [
      { name: 'Edge 140 Windows', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.82 Safari/537.36 Edg/140.0.0.0' },
    ],
  };

  const currentAgents = userAgents[browserType] || userAgents.chrome;

  // Country → coherent timezones + languages (random pick)
  const COUNTRY_PROFILES: Record<string, { timezones: string[]; languages: string[] }> = {
    US: { timezones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'], languages: ['en-US'] },
    GB: { timezones: ['Europe/London'], languages: ['en-GB'] },
    CA: { timezones: ['America/Toronto', 'America/Vancouver', 'America/Edmonton'], languages: ['en-US', 'fr-CA'] },
    FR: { timezones: ['Europe/Paris'], languages: ['fr-FR'] },
    DE: { timezones: ['Europe/Berlin'], languages: ['de-DE'] },
    AU: { timezones: ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth', 'Australia/Brisbane'], languages: ['en-AU'] },
    BR: { timezones: ['America/Sao_Paulo', 'America/Fortaleza', 'America/Manaus'], languages: ['pt-BR'] },
    ES: { timezones: ['Europe/Madrid'], languages: ['es-ES'] },
    IT: { timezones: ['Europe/Rome'], languages: ['it-IT'] },
    NL: { timezones: ['Europe/Amsterdam'], languages: ['nl-NL'] },
    JP: { timezones: ['Asia/Tokyo'], languages: ['ja-JP'] },
    KR: { timezones: ['Asia/Seoul'], languages: ['ko-KR'] },
    IN: { timezones: ['Asia/Kolkata'], languages: ['en-US'] },
    RU: { timezones: ['Europe/Moscow', 'Asia/Yekaterinburg', 'Asia/Novosibirsk'], languages: ['ru-RU'] },
    SG: { timezones: ['Asia/Singapore'], languages: ['en-US'] },
  };

  const pickRandom = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

  const timezones = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Sao_Paulo', 'America/Fortaleza', 'America/Manaus', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Moscow', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Seoul', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Yekaterinburg', 'Asia/Novosibirsk', 'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth', 'Australia/Brisbane'];
  const languages = ['en-US', 'en-GB', 'en-AU', 'es-ES', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'nl-NL', 'pt-BR', 'ru-RU', 'ja-JP', 'zh-CN', 'ko-KR'];
  const resolutions = ['1920x1080', '1366x768', '1440x900', '1536x864', '1600x900', '1280x720', '1280x800', '1920x1200', '2560x1440'];

  useEffect(() => {
    if (window.electronAPI?.fingerprint) {
      window.electronAPI.fingerprint.getPresets().then(setPresets).catch(console.error);
    }
  }, []);

  const handleGenerateFingerprint = async (countryCode?: string) => {
    try {
      if (!window.electronAPI?.fingerprint) {
        console.error('electronAPI.fingerprint not available');
        return;
      }
      setShowCountryPicker(false);
      setGenerating(true);
      setGenerated(false);
      const fp = await (window.electronAPI.fingerprint.generate as any)(os, browserType, countryCode);
      setFingerprint(fp);
      if (fp) {
        setUserAgent(fp.userAgent || '');
        setResolution(fp.screenResolution || '1920x1080');
        setHardwareConcurrency(fp.hardwareConcurrency || 8);
        setDeviceMemory(fp.deviceMemory || 8);
        setWebglVendor(fp.webglVendor || 'Google Inc.');
        setWebglRenderer(fp.webglRenderer || 'ANGLE (Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0)');

        // If a country was selected, force coherent timezone + language from local mapping
        if (countryCode && COUNTRY_PROFILES[countryCode]) {
          const profile = COUNTRY_PROFILES[countryCode];
          setTimezone(pickRandom(profile.timezones));
          setLanguage(pickRandom(profile.languages));
        } else {
          setTimezone(fp.timezone || 'UTC');
          setLanguage(fp.language || 'en-US');
        }

        setGenerated(true);
        setTimeout(() => setGenerated(false), 2000);
      }
    } catch (error) {
      console.error('Failed to generate fingerprint:', error);
    } finally {
      setGenerating(false);
    }
  };

  const handlePresetChange = (presetName: string) => {
    setSelectedPreset(presetName);
    const preset = presets.find(p => p.name === presetName);
    if (preset?.fingerprint) {
      const fp = preset.fingerprint;
      if (fp.userAgent) setUserAgent(fp.userAgent);
      if (fp.timezone) setTimezone(fp.timezone);
      if (fp.language) setLanguage(fp.language);
      if (fp.screenResolution) setResolution(fp.screenResolution);
    }
  };

  const handleAddTag = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && tagInput.trim()) {
      e.preventDefault();
      if (!tags.includes(tagInput.trim())) {
        setTags([...tags, tagInput.trim()]);
      }
      setTagInput('');
    }
  };

  const removeTag = (tag: string) => setTags(tags.filter(t => t !== tag));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!profileName.trim()) return;

    const platformUrls: Record<string, string> = {
      twitter: 'https://twitter.com',
      instagram: 'https://www.instagram.com',
      tiktok: 'https://www.tiktok.com',
      reddit: 'https://www.reddit.com',
      onlyfans: 'https://onlyfans.com',
      telegram: 'https://web.telegram.org',
    };

    const data: any = {
      name: profileName,
      userAgent: userAgent || currentAgents[0]?.value,
      proxy: connectionConfig.type === 'proxy' ? connectionConfig.proxy : null,
      connectionType: connectionConfig.type,
      connectionConfig,
      timezone: timezone || 'UTC',
      language,
      screenResolution: resolution,
      hardwareConcurrency,
      deviceMemory,
      webglVendor,
      webglRenderer,
      os,
      browserType,
      tags,
      notes,
      status: status !== 'none' ? status : null,
      preset: selectedPreset,
      fingerprint: {
        ...(fingerprint || {}),
        canvasNoise,
        audioNoise,
        webrtcMode,
        doNotTrack,
      },
      folderId: selectedFolderId,
      createdAt: new Date().toISOString(),
    };
    if (platform) data.platform = platform;
    if (!isEditMode && platform && platformUrls[platform]) data.lastUrl = platformUrls[platform];
    if (cookieImport.trim()) data.cookieImport = cookieImport.trim();

    if (isEditMode && editProfile && onUpdate) {
      delete data.createdAt;
      onUpdate(editProfile.id, data);
    } else {
      onCreate(data);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 modal-backdrop non-draggable" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-xl w-full max-w-[95vw] lg:max-w-2xl max-h-[85vh] overflow-hidden shadow-2xl non-draggable" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{isEditMode ? 'Edit Instance' : 'Create New Instance'}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="px-6 flex gap-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="px-3 py-2.5 text-[13px] font-medium flex items-center gap-1.5 transition-colors relative"
              style={{
                color: activeTab === tab.id ? 'var(--accent-light)' : 'var(--text-muted)',
              }}
            >
              {tab.icon}
              {tab.label}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px]" style={{ background: 'var(--accent)' }} />
              )}
            </button>
          ))}
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5 overflow-y-auto max-h-[calc(85vh-180px)]">
          {/* General Tab */}
          {activeTab === 'general' && (
            <>
              {/* Name + Folder */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Instance Name *</label>
                  <input name="profileName" type="text" value={profileName} onChange={e => setProfileName(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}
                    placeholder="My Instance" required autoFocus />
                </div>
                <div>
                  <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Folder</label>
                  <select value={selectedFolderId || ''} onChange={e => setSelectedFolderId(e.target.value || null)}
                    className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}>
                    <option value="">No folder</option>
                    {folders.map(f => <option key={f.id} value={f.id}>{f.icon || '\uD83D\uDCC1'} {f.name}</option>)}
                  </select>
                </div>
              </div>

              {/* Platform */}
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Platform</label>
                <div className="flex gap-2 flex-wrap">
                  {([
                    { id: 'twitter', label: 'Twitter', icon: '𝕏' },
                    { id: 'instagram', label: 'Instagram', icon: '📷' },
                    { id: 'tiktok', label: 'TikTok', icon: '🎵' },
                    { id: 'reddit', label: 'Reddit', icon: '🔴' },
                    { id: 'onlyfans', label: 'OnlyFans', icon: '💙' },
                    { id: 'telegram', label: 'Telegram', icon: '✈️' },
                    { id: 'other', label: 'Other', icon: '🌐' },
                  ] as { id: Platform; label: string; icon: string }[]).map(p => (
                    <button key={p.id} type="button" onClick={() => setPlatform(platform === p.id ? '' : p.id)}
                      className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all flex items-center gap-1.5"
                      style={{
                        background: platform === p.id ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                        border: `1px solid ${platform === p.id ? 'var(--accent)' : 'var(--border-default)'}`,
                        color: platform === p.id ? 'var(--accent-light)' : 'var(--text-secondary)',
                      }}>
                      <span>{p.icon}</span> {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Account Status */}
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Account Status</label>
                <div className="flex gap-2 flex-wrap">
                  {([
                    { id: 'none' as ProfileStatus, label: 'None', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' },
                    { id: 'ready' as ProfileStatus, label: 'Ready', color: 'var(--accent-light)', bg: 'var(--accent-subtle)' },
                    { id: 'active' as ProfileStatus, label: 'Active', color: 'var(--success)', bg: 'var(--success-subtle)' },
                    { id: 'warming' as ProfileStatus, label: 'Warming Up', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
                    { id: 'limited' as ProfileStatus, label: 'Limited', color: '#f97316', bg: 'rgba(249,115,22,0.1)' },
                    { id: 'shadowBanned' as ProfileStatus, label: 'Shadow Banned', color: '#a855f7', bg: 'rgba(168,85,247,0.1)' },
                    { id: 'banned' as ProfileStatus, label: 'Banned', color: 'var(--danger)', bg: 'var(--danger-subtle)' },
                    { id: 'suspended' as ProfileStatus, label: 'Suspended', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
                  ]).map(s => (
                    <button key={s.id} type="button" onClick={() => setStatus(s.id)}
                      className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all"
                      style={{
                        background: status === s.id ? s.bg : 'var(--bg-elevated)',
                        border: `1px solid ${status === s.id ? s.color : 'var(--border-default)'}`,
                        color: status === s.id ? s.color : 'var(--text-secondary)',
                      }}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* OS + Browser */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Operating System</label>
                  <div className="flex gap-2">
                    {(['windows', 'macos', 'linux'] as const).map(o => (
                      <button key={o} type="button" onClick={() => setOs(o)}
                        className="flex-1 px-3 py-2 rounded-lg text-[12px] font-medium transition-all text-center"
                        style={{
                          background: os === o ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                          border: `1px solid ${os === o ? 'var(--accent)' : 'var(--border-default)'}`,
                          color: os === o ? 'var(--accent-light)' : 'var(--text-secondary)',
                        }}>
                        {o === 'windows' ? 'Windows' : o === 'macos' ? 'macOS' : 'Linux'}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Browser</label>
                  <div className="flex gap-2">
                    {(['chrome', 'firefox', 'edge'] as const).map(b => (
                      <button key={b} type="button" onClick={() => setBrowserType(b)}
                        className="flex-1 px-3 py-2 rounded-lg text-[12px] font-medium transition-all text-center"
                        style={{
                          background: browserType === b ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                          border: `1px solid ${browserType === b ? 'var(--accent)' : 'var(--border-default)'}`,
                          color: browserType === b ? 'var(--accent-light)' : 'var(--text-secondary)',
                        }}>
                        {b.charAt(0).toUpperCase() + b.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* User Agent */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[12px] font-medium" style={labelStyle}>User Agent</label>
                  <button type="button" onClick={() => handleGenerateFingerprint()} disabled={generating}
                    className="px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 transition-all"
                    style={{ background: generated ? 'var(--success)' : 'linear-gradient(135deg, #7c3aed, #6366f1)', color: 'white', opacity: generating ? 0.7 : 1 }}>
                    {generating ? <><Loader2 size={12} className="animate-spin" /> Generating...</> : generated ? <><Check size={12} /> Generated!</> : <><Wand2 size={12} /> Auto-Generate</>}
                  </button>
                </div>
                <select value={userAgent} onChange={e => setUserAgent(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}>
                  <option value="">Select user agent</option>
                  {currentAgents.map(ua => <option key={ua.name} value={ua.value}>{ua.name}</option>)}
                  {userAgent && !currentAgents.find(ua => ua.value === userAgent) && <option value={userAgent}>{
                    (() => {
                      const chromeMatch = userAgent.match(/Chrome\/([\d.]+)/);
                      const osMatch = userAgent.includes('Windows') ? 'Windows' : userAgent.includes('Macintosh') ? 'Mac' : userAgent.includes('Linux') ? 'Linux' : '';
                      if (chromeMatch) return `Chrome ${chromeMatch[1].split('.')[0]} ${osMatch} (Generated)`;
                      return `Custom: ${userAgent.substring(0, 50)}...`;
                    })()
                  }</option>}
                </select>
              </div>

              {/* Tags */}
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Tags</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {tags.map(tag => (
                    <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
                      style={{ background: 'var(--accent-subtle)', color: 'var(--accent-light)' }}>
                      {tag}
                      <button type="button" onClick={() => removeTag(tag)} className="hover:opacity-70">&times;</button>
                    </span>
                  ))}
                </div>
                <input
                  type="text" value={tagInput} onChange={e => setTagInput(e.target.value)} onKeyDown={handleAddTag}
                  className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}
                  placeholder="Type a tag and press Enter..."
                />
              </div>

              {/* Notes */}
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Notes</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
                  style={inputStyle} rows={2} placeholder="Optional notes about this instance..." />
              </div>
            </>
          )}

          {/* Proxy Tab */}
          {activeTab === 'proxy' && (
            <>
              <div className="mb-2">
                <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  Configure the network connection for this instance.
                </p>
              </div>
              <ConnectionSelector value={connectionConfig} onChange={setConnectionConfig} />
            </>
          )}

          {/* Fingerprint Tab */}
          {activeTab === 'fingerprint' && (
            <>
              {/* Preset + Generate */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Preset</label>
                  <select value={selectedPreset} onChange={e => handlePresetChange(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}>
                    <option value="">Custom</option>
                    <optgroup label="Social Media">
                      {presets.filter(p => p.category === 'social-media').map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                    </optgroup>
                    <optgroup label="E-commerce">
                      {presets.filter(p => p.category === 'e-commerce').map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                    </optgroup>
                  </select>
                </div>
                <div className="flex items-end relative">
                  <button type="button" onClick={() => setShowCountryPicker(!showCountryPicker)}
                    className="w-full px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-[13px] font-medium text-white transition-all"
                    style={{ background: 'linear-gradient(135deg, #7c3aed, #6366f1)' }}>
                    {generating ? <><Loader2 size={14} className="animate-spin" /> Generating...</> : <><Wand2 size={15} /> Generate Fingerprint</>}
                  </button>
                  {showCountryPicker && (
                    <div className="absolute top-full left-0 right-0 mt-1 rounded-lg shadow-xl border z-50 py-1.5 max-h-[280px] overflow-y-auto"
                      style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-default)' }}>
                      <div className="px-2.5 py-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Select country for coherent fingerprint</div>
                      {[
                        { code: 'US', name: 'United States', flag: 'us' },
                        { code: 'GB', name: 'United Kingdom', flag: 'gb' },
                        { code: 'CA', name: 'Canada', flag: 'ca' },
                        { code: 'FR', name: 'France', flag: 'fr' },
                        { code: 'DE', name: 'Germany', flag: 'de' },
                        { code: 'AU', name: 'Australia', flag: 'au' },
                        { code: 'BR', name: 'Brazil', flag: 'br' },
                        { code: 'ES', name: 'Spain', flag: 'es' },
                        { code: 'IT', name: 'Italy', flag: 'it' },
                        { code: 'NL', name: 'Netherlands', flag: 'nl' },
                        { code: 'JP', name: 'Japan', flag: 'jp' },
                        { code: 'KR', name: 'South Korea', flag: 'kr' },
                        { code: 'IN', name: 'India', flag: 'in' },
                        { code: 'RU', name: 'Russia', flag: 'ru' },
                        { code: 'SG', name: 'Singapore', flag: 'sg' },
                      ].map(c => (
                        <button key={c.code} type="button"
                          onClick={() => handleGenerateFingerprint(c.code)}
                          className="w-full px-2.5 py-1.5 text-left flex items-center gap-2 text-[12px] hover:bg-white/5 transition-colors"
                          style={{ color: 'var(--text-primary)' }}>
                          <img src={`https://flagcdn.com/w20/${c.flag}.png`} alt={c.code} width={16} height={12} style={{ borderRadius: 2 }} />
                          {c.name}
                          <span className="ml-auto text-[10px]" style={{ color: 'var(--text-muted)' }}>{c.code}</span>
                        </button>
                      ))}
                      <div className="border-t my-1" style={{ borderColor: 'var(--border-default)' }} />
                      <button type="button"
                        onClick={() => handleGenerateFingerprint()}
                        className="w-full px-2.5 py-1.5 text-left flex items-center gap-2 text-[12px] hover:bg-white/5 transition-colors"
                        style={{ color: 'var(--text-muted)' }}>
                        <Shuffle size={14} /> Random country
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Timezone + Language + Resolution */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Timezone</label>
                  <select value={timezone} onChange={e => setTimezone(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}>
                    <option value="">Select</option>
                    {timezones.map(tz => <option key={tz} value={tz}>{tz}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Language</label>
                  <select value={language} onChange={e => setLanguage(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}>
                    {languages.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Resolution</label>
                  <select value={resolution} onChange={e => setResolution(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}>
                    {resolutions.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
              </div>

              {/* Hardware */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>CPU Cores</label>
                  <input type="number" min="2" max="32" value={hardwareConcurrency} onChange={e => setHardwareConcurrency(parseInt(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle} />
                </div>
                <div>
                  <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Memory (GB)</label>
                  <select value={deviceMemory} onChange={e => setDeviceMemory(parseInt(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}>
                    {[2, 4, 8, 16, 32].map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              </div>

              {/* WebGL */}
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>WebGL Vendor</label>
                <input type="text" value={webglVendor} onChange={e => setWebglVendor(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle} />
              </div>
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>WebGL Renderer</label>
                <input type="text" value={webglRenderer} onChange={e => setWebglRenderer(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle} />
              </div>

              {/* Canvas + Audio + WebRTC + DNT */}
              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-elevated)' }}>
                  <input type="checkbox" checked={canvasNoise} onChange={e => setCanvasNoise(e.target.checked)}
                    className="rounded border-gray-600 text-indigo-500 w-3.5 h-3.5" />
                  <div>
                    <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>Canvas Noise</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Add noise to canvas fingerprint</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-elevated)' }}>
                  <input type="checkbox" checked={audioNoise} onChange={e => setAudioNoise(e.target.checked)}
                    className="rounded border-gray-600 text-indigo-500 w-3.5 h-3.5" />
                  <div>
                    <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>Audio Noise</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Add noise to AudioContext</div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>WebRTC Mode</label>
                  <select value={webrtcMode} onChange={e => setWebrtcMode(e.target.value as any)}
                    className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}>
                    <option value="real">Real (expose real IP)</option>
                    <option value="fake">Fake (replace with proxy IP)</option>
                    <option value="disabled">Disabled (block WebRTC)</option>
                  </select>
                </div>
                <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-elevated)' }}>
                  <input type="checkbox" checked={doNotTrack} onChange={e => setDoNotTrack(e.target.checked)}
                    className="rounded border-gray-600 text-indigo-500 w-3.5 h-3.5" />
                  <div>
                    <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>Do Not Track</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Send DNT header</div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Advanced Tab */}
          {activeTab === 'advanced' && (
            <>
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Import Cookies (JSON)</label>
                <textarea value={cookieImport} onChange={e => setCookieImport(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono resize-none"
                  style={inputStyle} rows={8}
                  placeholder='[{"name":"session","value":"abc123","domain":".example.com"}]' />
                <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
                  Paste cookies in JSON array format. They will be loaded when the instance launches.
                </p>
              </div>
            </>
          )}
        </form>

        {/* Footer */}
        <div className="px-6 py-4 flex justify-between items-center" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <div className="flex gap-1.5">
            {tabs.map((tab, i) => (
              <div key={tab.id} className="w-1.5 h-1.5 rounded-full" style={{ background: activeTab === tab.id ? 'var(--accent)' : 'var(--border-default)' }} />
            ))}
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors"
              style={{ color: 'var(--text-secondary)', background: 'var(--bg-elevated)' }}>
              Cancel
            </button>
            <button onClick={handleSubmit}
              className="px-4 py-2 rounded-lg text-[13px] font-medium text-white transition-all"
              style={{ background: 'var(--accent)' }}>
              {isEditMode ? 'Save Changes' : 'Create Instance'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CreateProfileModal;
