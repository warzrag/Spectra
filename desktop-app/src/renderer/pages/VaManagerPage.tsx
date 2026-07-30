import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  KeyRound,
  Link2,
  Loader2,
  LogOut,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Users,
} from 'lucide-react';
import {
  Profile,
  VaManagerAccount,
  VaManagerConnectionStatus,
  VaManagerOrganization,
} from '../../types';
import { findLinkedProfile } from '../../shared/va-manager';
import { SessionImportProgress } from '../../shared/session-import';

interface VaManagerPageProps {
  profiles: Profile[];
  onUpdateProfile: (profileId: string, data: Partial<Profile>) => Promise<void>;
  onCreateAndConnect: (
    accounts: VaManagerAccount[],
    organizationId: string
  ) => Promise<{ successful: number; failed: number; manual: boolean; message: string }>;
  onRetryConnection: (
    account: VaManagerAccount,
    organizationId: string,
    profile: Profile
  ) => Promise<{ status: 'success' | 'manual' | 'failed'; message: string }>;
  importProgress: SessionImportProgress | null;
  onStopImport: () => Promise<void>;
}

type AuditFilter = 'all' | 'existing' | 'to-create' | 'missing' | 'ready';
type AccountSort = 'followers-desc' | 'followers-asc' | 'username';

function formatFollowers(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('fr-FR').format(value);
}

function formatDate(value?: string): string {
  if (!value) return 'Jamais';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function getMissingInformation(account: VaManagerAccount): string[] {
  const missing: string[] = [];
  if (!account.hasPassword) missing.push('Mot de passe X');
  else if (!account.passwordUsable) missing.push('Mot de passe X illisible');
  if (!account.hasTwoFa) missing.push('2FA à vérifier');
  if (!account.hasEmail) missing.push('Email');
  if (!account.hasEmailPassword) missing.push('Mot de passe email');
  else if (!account.emailPasswordUsable) missing.push('Mot de passe email illisible');
  return missing;
}

const statusStyle: Record<string, { label: string; color: string; background: string }> = {
  active: { label: 'Actif', color: 'var(--success)', background: 'var(--success-subtle)' },
  shadowban: { label: 'Shadowban', color: 'var(--warning)', background: 'var(--warning-subtle)' },
  banned: { label: 'Banni', color: 'var(--danger)', background: 'var(--danger-subtle)' },
  error: { label: 'Erreur', color: 'var(--danger)', background: 'var(--danger-subtle)' },
};

const VaManagerPage: React.FC<VaManagerPageProps> = ({
  profiles,
  onUpdateProfile,
  onCreateAndConnect,
  onRetryConnection,
  importProgress,
  onStopImport,
}) => {
  const [connection, setConnection] = useState<VaManagerConnectionStatus>({ connected: false });
  const [organizations, setOrganizations] = useState<VaManagerOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [accounts, setAccounts] = useState<VaManagerAccount[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [auditFilter, setAuditFilter] = useState<AuditFilter>('all');
  const [sort, setSort] = useState<AccountSort>('followers-desc');
  const [linkingAccountId, setLinkingAccountId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [linkActionLoading, setLinkActionLoading] = useState(false);
  const [showCreateConfirmation, setShowCreateConfirmation] = useState(false);
  const [createActionLoading, setCreateActionLoading] = useState(false);
  const [retryingAccountId, setRetryingAccountId] = useState<string | null>(null);

  const loadOrganizations = async (preferredOrganizationId?: string) => {
    const available = await window.electronAPI.vaManager.listOrganizations();
    setOrganizations(available);
    const selected =
      (preferredOrganizationId && available.some(org => org.id === preferredOrganizationId)
        ? preferredOrganizationId
        : '') ||
      available[0]?.id ||
      '';
    setOrganizationId(selected);
    return selected;
  };

  const loadAccounts = async (selectedOrganizationId?: string) => {
    setLoading(true);
    setError('');
    try {
      const result = await window.electronAPI.vaManager.listAccounts(selectedOrganizationId);
      setAccounts(result);
    } catch (loadError) {
      setAccounts([]);
      setError(loadError instanceof Error ? loadError.message : 'Impossible de charger les comptes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      setLoading(true);
      try {
        const current = await window.electronAPI.vaManager.status();
        if (cancelled) return;
        setConnection(current);
        if (current.connected) {
          const selected = await loadOrganizations(current.primaryOrganizationId);
          if (!cancelled) await loadAccounts(selected);
          return;
        }
      } catch (statusError) {
        if (!cancelled) {
          setError(statusError instanceof Error ? statusError.message : 'Connexion VA Manager indisponible');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    initialize();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleConnect = async (event: React.FormEvent) => {
    event.preventDefault();
    setConnecting(true);
    setError('');
    try {
      const current = await window.electronAPI.vaManager.connect(email, password);
      setPassword('');
      setConnection(current);
      const selected = await loadOrganizations(current.primaryOrganizationId);
      await loadAccounts(selected);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Connexion impossible');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    await window.electronAPI.vaManager.disconnect();
    setConnection({ connected: false });
    setOrganizations([]);
    setOrganizationId('');
    setAccounts([]);
    setPassword('');
    setError('');
  };

  const linkedByAccountId = useMemo(() => {
    const result = new Map<string, Profile>();
    for (const account of accounts) {
      const profile = findLinkedProfile(account, profiles);
      if (profile) result.set(account.id, profile);
    }
    return result;
  }, [accounts, profiles]);

  const visibleAccounts = useMemo(() => {
    const query = search.trim().toLowerCase().replace(/^@/, '');
    return accounts
      .filter(account => !query || account.username.toLowerCase().includes(query))
      .filter(account => statusFilter === 'all' || account.status === statusFilter)
      .filter(account => {
        const linked = linkedByAccountId.has(account.id);
        const complete = getMissingInformation(account).length === 0;
        if (auditFilter === 'existing') return linked;
        if (auditFilter === 'to-create') return !linked;
        if (auditFilter === 'missing') return !complete;
        if (auditFilter === 'ready') return !linked && complete;
        return true;
      })
      .sort((a, b) => {
        if (sort === 'username') return a.username.localeCompare(b.username);
        const aFollowers = a.followers ?? -1;
        const bFollowers = b.followers ?? -1;
        return sort === 'followers-asc'
          ? aFollowers - bFollowers
          : bFollowers - aFollowers;
      });
  }, [accounts, auditFilter, linkedByAccountId, search, sort, statusFilter]);

  const linkedCount = linkedByAccountId.size;
  const toCreateCount = accounts.length - linkedCount;
  const missingCount = accounts.filter(account => getMissingInformation(account).length > 0).length;
  const readyCount = accounts.filter(
    account =>
      !linkedByAccountId.has(account.id) &&
      getMissingInformation(account).length === 0
  ).length;
  const readyAccounts = accounts.filter(
    account =>
      !linkedByAccountId.has(account.id) &&
      getMissingInformation(account).length === 0
  );

  const handleCreateReadyAccounts = async () => {
    if (!organizationId || readyAccounts.length === 0) return;
    setCreateActionLoading(true);
    setError('');
    try {
      await onCreateAndConnect(readyAccounts, organizationId);
      setShowCreateConfirmation(false);
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : 'Création et connexion interrompues'
      );
    } finally {
      setCreateActionLoading(false);
    }
  };

  const linkingAccount = accounts.find(account => account.id === linkingAccountId);
  const availableProfiles = profiles
    .filter(profile => !profile.deleted)
    .filter(profile =>
      !profile.vaManagerAccountId ||
      profile.vaManagerAccountId === linkingAccountId
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const persistLink = async (account: VaManagerAccount, profile: Profile) => {
    setLinkActionLoading(true);
    setError('');
    try {
      const duplicate = profiles.find(
        candidate =>
          candidate.id !== profile.id &&
          candidate.vaManagerAccountId === account.id
      );
      if (duplicate) {
        throw new Error(`Ce compte est déjà lié à l’instance "${duplicate.name}"`);
      }
      if (profile.vaManagerAccountId && profile.vaManagerAccountId !== account.id) {
        throw new Error(`L’instance "${profile.name}" est déjà liée à un autre compte`);
      }
      await onUpdateProfile(profile.id, { vaManagerAccountId: account.id });
      setLinkingAccountId(null);
      setSelectedProfileId('');
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : 'Liaison impossible');
    } finally {
      setLinkActionLoading(false);
    }
  };

  const unlinkProfile = async (profile: Profile) => {
    setLinkActionLoading(true);
    setError('');
    try {
      await onUpdateProfile(profile.id, { vaManagerAccountId: null });
    } catch (unlinkError) {
      setError(unlinkError instanceof Error ? unlinkError.message : 'Impossible de délier l’instance');
    } finally {
      setLinkActionLoading(false);
    }
  };

  if (!connection.connected) {
    return (
      <div className="flex-1 overflow-auto p-6" style={{ background: 'var(--bg-base)' }}>
        <div className="max-w-lg mx-auto mt-12">
          <div
            className="rounded-2xl p-6"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
          >
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
              style={{ background: 'var(--accent-subtle)', color: 'var(--accent-light)' }}
            >
              <Database size={24} />
            </div>
            <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
              Connecter VA Manager
            </h1>
            <p className="text-sm mt-2 mb-6" style={{ color: 'var(--text-muted)' }}>
              Spectra affichera les comptes et leurs statistiques en lecture seule.
              Le mot de passe de connexion n’est pas enregistré.
            </p>
            <form onSubmit={handleConnect} className="space-y-4">
              <label className="block">
                <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Email VA Manager
                </span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg outline-none text-sm"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                />
              </label>
              <label className="block">
                <span className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Mot de passe VA Manager
                </span>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg outline-none text-sm"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                />
              </label>
              {error && (
                <div
                  className="px-3 py-2.5 rounded-lg text-xs flex items-start gap-2"
                  style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}
                >
                  <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={connecting}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-2 disabled:opacity-60"
                style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
              >
                {connecting ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
                {connecting ? 'Connexion…' : 'Se connecter'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ background: 'var(--bg-base)' }}>
      <header
        className="px-6 py-4 flex items-center justify-between gap-4 shrink-0"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div>
          <div className="flex items-center gap-2">
            <Database size={20} style={{ color: 'var(--accent-light)' }} />
            <h1 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Comptes VA Manager</h1>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Connecté avec {connection.email}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {organizations.length > 0 && (
            <select
              value={organizationId}
              onChange={async event => {
                const next = event.target.value;
                setOrganizationId(next);
                await loadAccounts(next);
              }}
              className="px-3 py-2 rounded-lg text-xs outline-none"
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
              }}
            >
              {organizations.map(organization => (
                <option key={organization.id} value={organization.id}>{organization.name}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => loadAccounts(organizationId)}
            disabled={loading}
            className="p-2 rounded-lg disabled:opacity-50"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
            title="Actualiser"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={handleDisconnect}
            className="px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-2"
            style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}
          >
            <LogOut size={14} /> Déconnecter
          </button>
        </div>
      </header>

      <div className="p-5 overflow-auto">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Audit automatique de {accounts.length} compte{accounts.length !== 1 ? 's' : ''}.
            Clique sur une carte pour afficher le groupe correspondant.
          </div>
          <button
            type="button"
            onClick={() => setShowCreateConfirmation(true)}
            disabled={readyCount === 0 || Boolean(importProgress?.running)}
            className="px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            Créer et connecter les prêts ({readyCount})
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
          {[
            { label: 'Instances déjà créées', value: linkedCount, icon: Link2, color: 'var(--success)', filter: 'existing' as AuditFilter },
            { label: 'Instances à créer', value: toCreateCount, icon: Users, color: 'var(--accent-light)', filter: 'to-create' as AuditFilter },
            { label: 'Informations manquantes', value: missingCount, icon: AlertTriangle, color: 'var(--danger)', filter: 'missing' as AuditFilter },
            { label: 'Prêts à créer et connecter', value: readyCount, icon: ShieldCheck, color: 'var(--success)', filter: 'ready' as AuditFilter },
          ].map(card => (
            <button
              type="button"
              key={card.label}
              onClick={() => setAuditFilter(current => current === card.filter ? 'all' : card.filter)}
              className="rounded-xl p-4 min-w-0 text-left transition-colors"
              style={{
                background: auditFilter === card.filter ? 'var(--accent-subtle)' : 'var(--bg-surface)',
                border: `1px solid ${auditFilter === card.filter ? 'var(--accent)' : 'var(--border-subtle)'}`,
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  {card.label}
                </span>
                <card.icon size={17} style={{ color: card.color }} />
              </div>
              <div className="text-xl font-bold mt-2 truncate" style={{ color: 'var(--text-primary)' }}>
                {card.value}
              </div>
            </button>
          ))}
        </div>

        {importProgress && (
          <div
            className="mb-4 rounded-xl p-4"
            style={{
              background: importProgress.status === 'failed'
                ? 'var(--danger-subtle)'
                : 'var(--accent-subtle)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {importProgress.running ? 'Création et connexion en cours' : 'Dernier traitement'}
                </div>
                <div className="text-[11px] mt-1 truncate" style={{ color: 'var(--text-secondary)' }}>
                  {importProgress.message}
                </div>
              </div>
              {importProgress.running && (
                <button
                  type="button"
                  onClick={onStopImport}
                  className="px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2"
                  style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}
                >
                  <Square size={13} fill="currentColor" /> Arrêter
                </button>
              )}
            </div>
            <div className="mt-3 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${importProgress.total > 0
                    ? Math.max(4, Math.round((importProgress.current / importProgress.total) * 100))
                    : 4}%`,
                  background: importProgress.status === 'failed'
                    ? 'var(--danger)'
                    : 'var(--accent-light)',
                }}
              />
            </div>
          </div>
        )}

        <div
          className="rounded-xl overflow-hidden"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}
        >
          <div className="p-3 flex flex-wrap items-center gap-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="relative flex-1 min-w-[200px]">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Rechercher un compte…"
                className="w-full pl-9 pr-3 py-2 rounded-lg text-xs outline-none"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>
            <select
              value={statusFilter}
              onChange={event => setStatusFilter(event.target.value)}
              className="px-3 py-2 rounded-lg text-xs outline-none"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            >
              <option value="all">Tous les statuts</option>
              <option value="active">Actifs</option>
              <option value="shadowban">Shadowban</option>
              <option value="banned">Bannis</option>
              <option value="error">Erreurs</option>
            </select>
            <select
              value={auditFilter}
              onChange={event => setAuditFilter(event.target.value as AuditFilter)}
              className="px-3 py-2 rounded-lg text-xs outline-none"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            >
              <option value="all">Audit complet</option>
              <option value="existing">Instances déjà créées</option>
              <option value="to-create">Instances à créer</option>
              <option value="missing">Informations manquantes</option>
              <option value="ready">Prêts à créer</option>
            </select>
            <select
              value={sort}
              onChange={event => setSort(event.target.value as AccountSort)}
              className="px-3 py-2 rounded-lg text-xs outline-none"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            >
              <option value="followers-desc">Plus d’abonnés</option>
              <option value="followers-asc">Moins d’abonnés</option>
              <option value="username">Nom A–Z</option>
            </select>
          </div>

          {error && (
            <div className="m-3 px-3 py-2.5 rounded-lg text-xs flex items-center gap-2" style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}>
              <AlertTriangle size={15} /> {error}
            </div>
          )}

          <div className="overflow-x-auto">
            <div className="min-w-[980px]">
              <div className="grid grid-cols-[minmax(180px,1.5fr)_130px_120px_minmax(180px,1fr)_170px_130px] px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                <span>Compte</span>
                <span>Abonnés</span>
                <span>Statut</span>
                <span>Instance Spectra</span>
                <span>Audit connexion</span>
                <span>Dernier scan</span>
              </div>

              {loading ? (
                <div className="py-16 flex items-center justify-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                  <Loader2 size={18} className="animate-spin" /> Chargement des comptes…
                </div>
              ) : visibleAccounts.length === 0 ? (
                <div className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  Aucun compte ne correspond aux filtres.
                </div>
              ) : (
                <div>
              {visibleAccounts.map(account => {
                const profile = linkedByAccountId.get(account.id);
                const missingInformation = getMissingInformation(account);
                const visual = statusStyle[account.status] || {
                  label: account.status || 'Inconnu',
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-elevated)',
                };
                return (
                  <div
                    key={account.id}
                    className="grid grid-cols-[minmax(180px,1.5fr)_130px_120px_minmax(180px,1fr)_170px_130px] items-center px-4 py-3 text-xs"
                    style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)' }}
                  >
                    <div className="min-w-0">
                      <div className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>@{account.username}</div>
                      <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{account.id}</div>
                    </div>
                    <div className="font-semibold tabular-nums" style={{ color: account.followers !== null ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {formatFollowers(account.followers)}
                    </div>
                    <div>
                      <span className="inline-flex px-2 py-1 rounded-full text-[10px] font-semibold" style={{ color: visual.color, background: visual.background }}>
                        {visual.label}
                      </span>
                    </div>
                    <div className="min-w-0">
                      {profile ? (
                        <>
                          <div className="flex items-center gap-1.5 font-medium truncate" style={{ color: 'var(--success)' }}>
                            <Link2 size={13} className="shrink-0" /> {profile.name}
                          </div>
                          <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            {profile.vaManagerAccountId === account.id ? 'Liaison confirmée' : 'Correspondance détectée'}
                            {' · '}
                            {profile.proxy?.host ? 'Proxy assigné' : 'Proxy manquant'}
                          </div>
                          {profile.vaManagerLoginStatus && (
                            <div
                              className="text-[10px] mt-1"
                              style={{
                                color: profile.vaManagerLoginStatus === 'connected'
                                  ? 'var(--success)'
                                  : profile.vaManagerLoginStatus === 'failed'
                                    ? 'var(--danger)'
                                    : 'var(--warning)',
                              }}
                              title={profile.vaManagerLoginMessage}
                            >
                              {profile.vaManagerLoginStatus === 'connected'
                                ? 'Connexion X confirmée'
                                : profile.vaManagerLoginStatus === 'manual'
                                  ? 'Vérification manuelle requise'
                                  : profile.vaManagerLoginStatus === 'failed'
                                    ? 'Connexion X échouée'
                                    : 'Connexion X en attente'}
                            </div>
                          )}
                          <div className="flex items-center gap-1.5 mt-1.5">
                            {profile.vaManagerAccountId !== account.id && (
                              <button
                                onClick={() => persistLink(account, profile)}
                                disabled={linkActionLoading}
                                className="px-2 py-1 rounded text-[9px] font-semibold disabled:opacity-50"
                                style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}
                              >
                                Confirmer
                              </button>
                            )}
                            {profile.vaManagerAccountId === account.id && (
                              <>
                                <button
                                  onClick={() => unlinkProfile(profile)}
                                  disabled={linkActionLoading || retryingAccountId === account.id}
                                  className="px-2 py-1 rounded text-[9px] font-semibold disabled:opacity-50"
                                  style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}
                                >
                                  Délier
                                </button>
                                {profile.vaManagerLoginStatus &&
                                  profile.vaManagerLoginStatus !== 'connected' && (
                                    <button
                                      onClick={async () => {
                                        setRetryingAccountId(account.id);
                                        setError('');
                                        try {
                                          await onRetryConnection(account, organizationId, profile);
                                        } catch (retryError) {
                                          setError(
                                            retryError instanceof Error
                                              ? retryError.message
                                              : 'Nouvelle tentative impossible'
                                          );
                                        } finally {
                                          setRetryingAccountId(null);
                                        }
                                      }}
                                      disabled={
                                        retryingAccountId === account.id ||
                                        Boolean(importProgress?.running)
                                      }
                                      className="px-2 py-1 rounded text-[9px] font-semibold disabled:opacity-50"
                                      style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}
                                    >
                                      {retryingAccountId === account.id ? 'Connexion…' : 'Réessayer'}
                                    </button>
                                  )}
                              </>
                            )}
                          </div>
                        </>
                      ) : (
                        <div>
                          <div className="text-[11px]" style={{ color: 'var(--warning)' }}>Aucune instance trouvée</div>
                          <button
                            onClick={() => {
                              setLinkingAccountId(account.id);
                              setSelectedProfileId('');
                            }}
                            className="px-2 py-1 rounded text-[9px] font-semibold mt-1.5"
                            style={{ background: 'var(--accent-subtle)', color: 'var(--accent-light)' }}
                          >
                            Lier une instance
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap pr-2">
                      {missingInformation.length === 0 ? (
                        <span
                          className="px-2 py-1 rounded text-[9px] font-semibold"
                          style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}
                        >
                          Informations complètes
                        </span>
                      ) : missingInformation.map(label => (
                        <span
                          key={label}
                          className="px-1.5 py-0.5 rounded text-[9px] font-semibold"
                          style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {formatDate(account.lastScannedAt || account.followersUpdatedAt)}
                    </div>
                  </div>
                );
              })}
                </div>
              )}
            </div>
          </div>
          <div className="px-4 py-2.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {visibleAccounts.length} compte{visibleAccounts.length !== 1 ? 's' : ''} affiché{visibleAccounts.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>

      {linkingAccount && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-5"
          style={{ background: 'rgba(0, 0, 0, 0.72)' }}
          onMouseDown={event => {
            if (event.target === event.currentTarget && !linkActionLoading) {
              setLinkingAccountId(null);
              setSelectedProfileId('');
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl p-5"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
          >
            <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
              Lier @{linkingAccount.username}
            </h2>
            <p className="text-xs mt-1 mb-4" style={{ color: 'var(--text-muted)' }}>
              Choisis l’instance Spectra correspondant à ce compte.
            </p>
            <select
              value={selectedProfileId}
              onChange={event => setSelectedProfileId(event.target.value)}
              className="w-full px-3 py-2.5 rounded-lg text-sm outline-none"
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
              }}
            >
              <option value="">Sélectionner une instance…</option>
              {availableProfiles.map(profile => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}{profile.proxy?.host ? ' · proxy assigné' : ' · sans proxy'}
                </option>
              ))}
            </select>
            {availableProfiles.length === 0 && (
              <div className="text-xs mt-3" style={{ color: 'var(--warning)' }}>
                Aucune instance disponible pour cette liaison.
              </div>
            )}
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => {
                  setLinkingAccountId(null);
                  setSelectedProfileId('');
                }}
                disabled={linkActionLoading}
                className="px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-50"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
              >
                Annuler
              </button>
              <button
                onClick={() => {
                  const profile = profiles.find(candidate => candidate.id === selectedProfileId);
                  if (profile) persistLink(linkingAccount, profile);
                }}
                disabled={!selectedProfileId || linkActionLoading}
                className="px-3 py-2 rounded-lg text-xs font-semibold text-white flex items-center gap-2 disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
              >
                {linkActionLoading && <Loader2 size={14} className="animate-spin" />}
                Confirmer la liaison
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreateConfirmation && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-5"
          style={{ background: 'rgba(0,0,0,0.72)' }}
          onMouseDown={event => {
            if (event.target === event.currentTarget && !createActionLoading) {
              setShowCreateConfirmation(false);
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl p-5"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
            }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: 'var(--accent-subtle)', color: 'var(--accent-light)' }}
              >
                <ShieldCheck size={21} />
              </div>
              <div>
                <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Créer et connecter {readyCount} compte{readyCount !== 1 ? 's' : ''}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Organisation {organizations.find(org => org.id === organizationId)?.name || 'sélectionnée'}
                </div>
              </div>
            </div>
            <div
              className="mt-4 rounded-xl p-3 text-xs leading-relaxed"
              style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
            >
              Spectra vérifiera les proxies, respectera la limite de trois comptes par proxy,
              créera les instances une par une et fermera chaque fenêtre après une connexion confirmée.
              Si la capacité proxy est insuffisante, seuls les comptes pouvant recevoir un proxy seront
              traités et les autres resteront en attente.
              En cas de vérification X, le traitement se mettra en pause et laissera la fenêtre ouverte.
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreateConfirmation(false)}
                disabled={createActionLoading}
                className="px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-50"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={handleCreateReadyAccounts}
                disabled={createActionLoading}
                className="px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {createActionLoading && <Loader2 size={14} className="animate-spin" />}
                Confirmer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VaManagerPage;
