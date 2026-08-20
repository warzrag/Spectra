import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { COMPTES_MAX_PAR_PROXY } from '../../shared/proxy-identity';
import { SessionImportProgress } from '../../shared/session-import';

interface VaManagerPageProps {
  profiles: Profile[];
  folders: { id: string; name: string }[];
  onUpdateProfile: (profileId: string, data: Partial<Profile>) => Promise<void>;
  onCreateAndConnect: (
    accounts: VaManagerAccount[],
    organizationId: string,
    folderId?: string | null
  ) => Promise<{ successful: number; failed: number; manual: boolean; message: string }>;
  onRetryConnection: (
    account: VaManagerAccount,
    organizationId: string,
    profile: Profile
  ) => Promise<{ status: 'success' | 'manual' | 'failed'; message: string }>;
  importProgress: SessionImportProgress | null;
  onStopImport: () => Promise<void>;
}

type AuditFilter = 'all' | CategorieCompte;
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

// Quatre cas, et un compte tombe dans un seul. Les compteurs du haut et les
// lignes du tableau lisent ce meme calcul : ils ne peuvent plus se contredire.
type CategorieCompte = 'a-creer' | 'a-completer' | 'a-finir' | 'en-place';

type EtatCompte = {
  phrase: string;
  ton: 'pret' | 'fait' | 'attente' | 'bloque';
  action: null | 'creer' | 'reprendre' | 'reessayer' | 'confirmer' | 'lier';
  categorie: CategorieCompte;
  detail?: string;
};

/**
 * Une ligne, une phrase, une action. La page affichait six colonnes par compte
 * -- statut, abonnes, instance, proxy, connexion, dernier scan -- et l'action
 * utile en tout petit au milieu. On repond desormais a une seule question :
 * ou en est ce compte, et qu'est-ce que je fais.
 */
function etatDuCompte(
  account: VaManagerAccount,
  profile: Profile | undefined,
  informationsManquantes: string[]
): EtatCompte {
  const ilManque = (): EtatCompte => ({
    phrase:
      informationsManquantes.length > 1
        ? `Il manque ${informationsManquantes.length} informations`
        : `Il manque ${informationsManquantes[0].toLowerCase()}`,
    ton: 'bloque',
    action: null,
    categorie: 'a-completer',
    detail: informationsManquantes.join(', '),
  });

  if (!profile) {
    if (informationsManquantes.length > 0) return ilManque();
    return { phrase: 'Prêt', ton: 'pret', action: 'creer', categorie: 'a-creer' };
  }

  // Une instance a ete trouvee par le nom, mais personne n'a confirme que
  // c'est bien celle de ce compte.
  if (profile.vaManagerAccountId !== account.id) {
    return {
      phrase: 'Une instance semble correspondre',
      ton: 'attente',
      action: 'confirmer',
      categorie: 'a-finir',
      detail: profile.name,
    };
  }

  if (profile.vaManagerLoginStatus === 'connected') {
    return { phrase: 'En place et connecté', ton: 'fait', action: null, categorie: 'en-place', detail: profile.name };
  }

  // Proposer de reessayer sans les informations necessaires, c'est promettre
  // un echec. On dit ce qui manque, et on n'affiche aucun bouton.
  if (informationsManquantes.length > 0) return ilManque();

  switch (profile.vaManagerLoginStatus) {
    case 'manual':
      return { phrase: 'Connexion à finir à la main', ton: 'attente', action: 'reprendre', categorie: 'a-finir', detail: profile.name };
    case 'failed':
      return { phrase: 'La connexion a échoué', ton: 'bloque', action: 'reessayer', categorie: 'a-finir', detail: profile.name };
    case 'pending':
      return { phrase: 'Connexion en cours', ton: 'attente', action: null, categorie: 'a-finir', detail: profile.name };
    default:
      return { phrase: 'Instance en place', ton: 'fait', action: null, categorie: 'en-place', detail: profile.name };
  }
}

const tonCouleur: Record<EtatCompte['ton'], string> = {
  pret: 'var(--accent-light)',
  fait: 'var(--success)',
  attente: 'var(--warning)',
  bloque: 'var(--danger)',
};

const statusStyle: Record<string, { label: string; color: string; background: string }> = {
  active: { label: 'Actif', color: 'var(--success)', background: 'var(--success-subtle)' },
  shadowban: { label: 'Shadowban', color: 'var(--warning)', background: 'var(--warning-subtle)' },
  banned: { label: 'Banni', color: 'var(--danger)', background: 'var(--danger-subtle)' },
  error: { label: 'Erreur', color: 'var(--danger)', background: 'var(--danger-subtle)' },
};

const VaManagerPage: React.FC<VaManagerPageProps> = ({
  profiles,
  folders,
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
  const [filtreVa, setFiltreVa] = useState('all');
  const [sort, setSort] = useState<AccountSort>('followers-desc');
  const [linkingAccountId, setLinkingAccountId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [linkActionLoading, setLinkActionLoading] = useState(false);
  const [showCreateConfirmation, setShowCreateConfirmation] = useState(false);
  const [createActionLoading, setCreateActionLoading] = useState(false);
  // La creation demande une seule chose : ou ranger l'instance. `null` signifie
  // qu'aucune creation n'est en cours ; un tableau vide n'existe jamais.
  const [comptesACreer, setComptesACreer] = useState<VaManagerAccount[] | null>(null);
  const [dossierChoisi, setDossierChoisi] = useState('__none__');
  // Les comptes coches a la main. Vide = on traite tout ce qui est pret, comme
  // avant : une selection vide ne doit pas bloquer le bouton.
  const [comptesCoches, setComptesCoches] = useState<Set<string>>(new Set());
  const [retryingAccountId, setRetryingAccountId] = useState<string | null>(null);
  const attemptedExistingCookieSyncs = useRef(new Set<string>());

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

  useEffect(() => {
    if (!connection.connected || !organizationId) return;
    const refreshCookiesStatus = () => {
      loadAccounts(organizationId).catch(() => {});
    };
    window.addEventListener('spectra:va-manager-cookies-synced', refreshCookiesStatus);
    return () => {
      window.removeEventListener('spectra:va-manager-cookies-synced', refreshCookiesStatus);
    };
  }, [connection.connected, organizationId]);

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

  useEffect(() => {
    if (!connection.connected || !organizationId || accounts.length === 0) return;
    const pending = accounts
      .filter(account => !account.hasCookies)
      .map(account => ({ account, profile: linkedByAccountId.get(account.id) }))
      .filter(({ account, profile }) =>
        Boolean(
          profile &&
          profile.vaManagerAccountId === account.id &&
          !attemptedExistingCookieSyncs.current.has(`${profile.id}:${account.id}`)
        )
      ) as { account: VaManagerAccount; profile: Profile }[];
    if (pending.length === 0) return;

    for (const { account, profile } of pending) {
      attemptedExistingCookieSyncs.current.add(`${profile.id}:${account.id}`);
    }
    Promise.all(
      pending.map(({ account, profile }) =>
        window.electronAPI.vaManager.syncProfileCookies(
          profile.id,
          account.id,
          account.organizationId || organizationId
        )
      )
    ).then(results => {
      if (results.some(result => result.success)) {
        loadAccounts(organizationId).catch(() => {});
      }
    }).catch(() => {});
  }, [
    accounts,
    connection.connected,
    linkedByAccountId,
    organizationId,
  ]);

  // Un seul calcul pour toute la page : les compteurs, les filtres et les lignes
  // en decoulent. C'est ce qui garantit qu'ils disent la meme chose.
  const etatParCompte = useMemo(() => {
    const resultat = new Map<string, EtatCompte>();
    for (const account of accounts) {
      resultat.set(
        account.id,
        etatDuCompte(account, linkedByAccountId.get(account.id), getMissingInformation(account))
      );
    }
    return resultat;
  }, [accounts, linkedByAccountId]);

  // La liste des assistants, deduite des comptes eux-memes plutot que demandee
  // a part : elle ne montre ainsi que les VA qui ont vraiment des comptes dans
  // l'organisation ouverte, avec leur nombre.
  const listeVa = useMemo(() => {
    const parVa = new Map<string, { id: string; nom: string; combien: number }>();
    for (const account of accounts) {
      if (!account.vaId) continue;
      const connu = parVa.get(account.vaId);
      if (connu) connu.combien++;
      else parVa.set(account.vaId, {
        id: account.vaId,
        nom: account.vaName || 'VA sans nom',
        combien: 1,
      });
    }
    return [...parVa.values()].sort((a, b) => a.nom.localeCompare(b.nom));
  }, [accounts]);

  const visibleAccounts = useMemo(() => {
    const query = search.trim().toLowerCase().replace(/^@/, '');
    return accounts
      .filter(account => !query || account.username.toLowerCase().includes(query))
      .filter(account => statusFilter === 'all' || account.status === statusFilter)
      .filter(account => {
        if (filtreVa === 'all') return true;
        if (filtreVa === 'sans-va') return !account.vaId;
        return account.vaId === filtreVa;
      })
      .filter(account => {
        if (auditFilter === 'all') return true;
        return etatParCompte.get(account.id)?.categorie === auditFilter;
      })
      .sort((a, b) => {
        if (sort === 'username') return a.username.localeCompare(b.username);
        const aFollowers = a.followers ?? -1;
        const bFollowers = b.followers ?? -1;
        return sort === 'followers-asc'
          ? aFollowers - bFollowers
          : bFollowers - aFollowers;
      });
  }, [accounts, auditFilter, etatParCompte, filtreVa, search, sort, statusFilter]);

  // Chaque compte compte pour un, dans une seule case. Les quatre nombres
  // s'additionnent au total : plus de recouvrement, plus de doute.
  const compter = (categorie: CategorieCompte) =>
    accounts.filter(account => etatParCompte.get(account.id)?.categorie === categorie).length;
  const aCreerCount = compter('a-creer');
  const aCompleterCount = compter('a-completer');
  const aFinirCount = compter('a-finir');
  const enPlaceCount = compter('en-place');
  const readyCount = aCreerCount;
  const readyAccounts = accounts.filter(
    account => etatParCompte.get(account.id)?.categorie === 'a-creer'
  );

  // Un compte est traitable s'il y a quelque chose a faire : creer l'instance,
  // ou terminer une connexion. Un compte incomplet ou deja en place ne l'est
  // pas -- le cocher ne servirait a rien.
  const estTraitable = (account: VaManagerAccount) => {
    const categorie = etatParCompte.get(account.id)?.categorie;
    return categorie === 'a-creer' || categorie === 'a-finir';
  };
  const cochablesVisibles = visibleAccounts.filter(estTraitable);
  const selectionTraitable = accounts.filter(
    (account) => comptesCoches.has(account.id) && estTraitable(account)
  );
  const toutCoche =
    cochablesVisibles.length > 0 &&
    cochablesVisibles.every((account) => comptesCoches.has(account.id));

  const basculerCompte = (identifiant: string) => {
    setComptesCoches((actuels) => {
      const suivants = new Set(actuels);
      if (suivants.has(identifiant)) suivants.delete(identifiant);
      else suivants.add(identifiant);
      return suivants;
    });
  };

  const handleCreateReadyAccounts = async () => {
    // Un seul chemin, qu'il s'agisse d'un compte, d'une selection ou de tout
    // ce qui est pret : le dossier de destination est demande dans tous les cas.
    const cibles = comptesACreer && comptesACreer.length > 0
      ? comptesACreer
      : (selectionTraitable.length > 0 ? selectionTraitable : readyAccounts);
    if (!organizationId || cibles.length === 0) return;
    setCreateActionLoading(true);
    setError('');
    try {
      // Deux cas dans une meme selection, et deux chemins differents : un compte
      // sans instance doit etre cree puis connecte, un compte qui en a une n'a
      // que sa connexion a reprendre. Les melanger enverrait les seconds dans
      // une creation qui les ignore en silence.
      const aCreer = cibles.filter(
        (compte) => etatParCompte.get(compte.id)?.categorie === 'a-creer'
      );
      const aFinir = cibles.filter(
        (compte) => etatParCompte.get(compte.id)?.categorie === 'a-finir'
      );

      if (aCreer.length > 0) {
        await onCreateAndConnect(aCreer, organizationId, dossierChoisi);
      }
      // Un compte a la fois : deux fenetres de connexion X en meme temps sur le
      // meme poste, c'est la meilleure facon de les faire echouer toutes les deux.
      for (const compte of aFinir) {
        const profil = linkedByAccountId.get(compte.id);
        if (!profil) continue;
        setRetryingAccountId(compte.id);
        try {
          await onRetryConnection(compte, organizationId, profil);
        } finally {
          setRetryingAccountId(null);
        }
      }

      setShowCreateConfirmation(false);
      setComptesACreer(null);
      setComptesCoches(new Set());
      await loadAccounts(organizationId);
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
      await onUpdateProfile(profile.id, {
        vaManagerAccountId: account.id,
        vaManagerOrganizationId: account.organizationId || organizationId,
      });
      const cookieSync = await window.electronAPI.vaManager.syncProfileCookies(
        profile.id,
        account.id,
        account.organizationId || organizationId
      );
      if (cookieSync.success) {
        await loadAccounts(account.organizationId || organizationId);
      }
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
      await onUpdateProfile(profile.id, {
        vaManagerAccountId: null,
        vaManagerOrganizationId: null,
      });
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
          {connection.memorisee === false && (
            // Le coffre du systeme a refuse : la session tient le temps de
            // l'application, rien n'est ecrit sur le disque. Le dire, sinon la
            // deconnexion au prochain demarrage passe pour une panne.
            <p className="text-xs mt-1" style={{ color: 'var(--warning, #f59e0b)' }}>
              Session non mémorisée — à refaire au prochain démarrage. Le coffre
              du système est indisponible.
            </p>
          )}
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
            disabled={
              (selectionTraitable.length === 0 && readyCount === 0) ||
              Boolean(importProgress?.running)
            }
            className="px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            {selectionTraitable.length > 0
              ? `Connecter la sélection (${selectionTraitable.length})`
              : `Créer et connecter les prêts (${readyCount})`}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
          {[
            { label: 'À créer', value: aCreerCount, icon: ShieldCheck, color: 'var(--accent-light)', filter: 'a-creer' as AuditFilter },
            { label: 'À compléter', value: aCompleterCount, icon: AlertTriangle, color: 'var(--danger)', filter: 'a-completer' as AuditFilter },
            { label: 'À finir', value: aFinirCount, icon: RefreshCw, color: 'var(--warning)', filter: 'a-finir' as AuditFilter },
            { label: 'En place', value: enPlaceCount, icon: Link2, color: 'var(--success)', filter: 'en-place' as AuditFilter },
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
              {/* Les memes quatre categories que les cartes du haut, avec les
                  memes mots. Deux filtres qui ne parlent pas la meme langue,
                  c'est un filtre qui ne marche pas. */}
              <option value="all">Tous les comptes</option>
              <option value="a-creer">À créer</option>
              <option value="a-completer">À compléter</option>
              <option value="a-finir">À finir</option>
              <option value="en-place">En place</option>
            </select>
            {/* Le filtre par assistant. VA Manager montre qui tient quel
                compte ; sans lui ici, creer les instances d'une seule personne
                obligeait a les cocher une par une. */}
            {listeVa.length > 0 && (
              <select
                value={filtreVa}
                onChange={event => setFiltreVa(event.target.value)}
                className="px-3 py-2 rounded-lg text-xs outline-none"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              >
                <option value="all">Tous les VA</option>
                {listeVa.map(va => (
                  <option key={va.id} value={va.id}>{va.nom} ({va.combien})</option>
                ))}
                <option value="sans-va">Sans VA</option>
              </select>
            )}
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
              <div className="grid grid-cols-[34px_minmax(220px,1.4fr)_minmax(240px,1fr)_190px] items-center px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                <input
                  type="checkbox"
                  checked={toutCoche}
                  onChange={() => {
                    // Tout cocher ne touche qu'a ce qui est affiche : une case
                    // qui selectionne des lignes invisibles est un piege.
                    setComptesCoches((actuels) => {
                      const suivants = new Set(actuels);
                      for (const compte of cochablesVisibles) {
                        if (toutCoche) suivants.delete(compte.id);
                        else suivants.add(compte.id);
                      }
                      return suivants;
                    });
                  }}
                  disabled={cochablesVisibles.length === 0}
                  title={
                    cochablesVisibles.length === 0
                      ? 'Aucun compte à traiter dans cette liste'
                      : 'Tout cocher dans cette liste'
                  }
                  style={{ cursor: 'pointer' }}
                />
                <span>Compte</span>
                <span>Où ça en est</span>
                <span>Action</span>
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
                const etat =
                  etatParCompte.get(account.id) ||
                  etatDuCompte(account, profile, missingInformation);
                const visual = statusStyle[account.status] || {
                  label: account.status || 'Inconnu',
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-elevated)',
                };
                return (
                  <div
                    key={account.id}
                    className="grid grid-cols-[34px_minmax(220px,1.4fr)_minmax(240px,1fr)_190px] items-center px-4 py-3 text-xs"
                    style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)' }}
                  >
                    <input
                      type="checkbox"
                      checked={comptesCoches.has(account.id)}
                      onChange={() => basculerCompte(account.id)}
                      disabled={!estTraitable(account)}
                      title={
                        estTraitable(account)
                          ? 'Traiter ce compte'
                          : etat.categorie === 'en-place'
                            ? 'Déjà en place et connecté'
                            : 'Il manque des informations dans VA Manager'
                      }
                      style={{ cursor: estTraitable(account) ? 'pointer' : 'not-allowed' }}
                    />
                    {/* Colonne 1 : qui c'est. Le reste (abonnes, dernier scan)
                        reste lisible mais ne prend plus la place de l'action. */}
                    <div className="min-w-0 pr-3">
                      <div className="font-semibold truncate flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                        <span className="truncate">@{account.username}</span>
                        {/* L'assistant qui tient le compte. Present dans VA
                            Manager, il manquait ici -- on ne savait pas de qui
                            etait un compte sans changer d'application. */}
                        {account.vaName && (
                          <span
                            className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium"
                            style={{
                              background: 'var(--accent-subtle)',
                              color: 'var(--accent-light)',
                            }}
                            title={`Assistant : ${account.vaName}`}
                          >
                            {account.vaName}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] mt-0.5 flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--text-muted)' }}>
                        <span style={{ color: visual.color }}>{visual.label}</span>
                        <span>·</span>
                        <span>{formatFollowers(account.followers)} abonnés</span>
                        <span>·</span>
                        <span>vu {formatDate(account.lastScannedAt || account.followersUpdatedAt)}</span>
                        <span>·</span>
                        {/* La sauvegarde de session vit dans VA Manager : c'est
                            elle qui permet de retrouver le compte connecte
                            ailleurs. On la garde visible, mais discrete. */}
                        <span style={{ color: account.hasCookies ? 'var(--success)' : 'var(--warning)' }}>
                          {account.hasCookies ? 'Cookies X synchronisés' : 'Cookies X en attente'}
                        </span>
                      </div>
                    </div>

                    {/* Colonne 2 : une phrase, en francais, qui dit ou ca en est. */}
                    <div className="min-w-0 pr-3">
                      <div className="font-medium" style={{ color: tonCouleur[etat.ton] }}>
                        {etat.phrase}
                      </div>
                      {etat.detail && (
                        <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }} title={etat.detail}>
                          {etat.detail}
                        </div>
                      )}
                    </div>

                    {/* Colonne 3 : un bouton, ou rien du tout. */}
                    <div className="flex items-center gap-1.5">
                      {etat.action === 'creer' && (
                        <button
                          onClick={() => {
                            setComptesACreer([account]);
                            setDossierChoisi('__none__');
                          }}
                          disabled={Boolean(importProgress?.running)}
                          className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white disabled:opacity-40"
                          style={{ background: 'var(--accent)' }}
                        >
                          Créer l’instance
                        </button>
                      )}

                      {etat.action === 'confirmer' && profile && (
                        <button
                          onClick={() => persistLink(account, profile)}
                          disabled={linkActionLoading}
                          className="px-3 py-1.5 rounded-lg text-[11px] font-semibold disabled:opacity-50"
                          style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}
                        >
                          C’est bien lui
                        </button>
                      )}

                      {(etat.action === 'reprendre' || etat.action === 'reessayer') && profile && (
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
                          disabled={retryingAccountId === account.id || Boolean(importProgress?.running)}
                          className="px-3 py-1.5 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-50"
                          style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}
                        >
                          {retryingAccountId === account.id && <Loader2 size={12} className="animate-spin" />}
                          {etat.action === 'reessayer' ? 'Réessayer' : 'Reprendre'}
                        </button>
                      )}

                      {/* Actions de second plan, volontairement discretes. */}
                      {!profile && (
                        <button
                          onClick={() => {
                            setLinkingAccountId(account.id);
                            setSelectedProfileId('');
                          }}
                          className="px-2 py-1.5 rounded-lg text-[10px]"
                          style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}
                          title="Rattacher une instance qui existe deja sous un autre nom"
                        >
                          Lier
                        </button>
                      )}
                      {profile && profile.vaManagerAccountId === account.id && (
                        <button
                          onClick={() => unlinkProfile(profile)}
                          disabled={linkActionLoading}
                          className="px-2 py-1.5 rounded-lg text-[10px] disabled:opacity-50"
                          style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}
                        >
                          Délier
                        </button>
                      )}
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

      {(showCreateConfirmation || comptesACreer !== null) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-5"
          style={{ background: 'rgba(0,0,0,0.72)' }}
          onMouseDown={event => {
            if (event.target === event.currentTarget && !createActionLoading) {
              setShowCreateConfirmation(false);
              setComptesACreer(null);
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
                  {comptesACreer && comptesACreer.length === 1
                    ? `Créer et connecter @${comptesACreer[0].username}`
                    : (() => {
                        const nombre =
                          comptesACreer?.length ??
                          (selectionTraitable.length > 0 ? selectionTraitable.length : readyCount);
                        return `Créer et connecter ${nombre} compte${nombre !== 1 ? 's' : ''}`;
                      })()}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Organisation {organizations.find(org => org.id === organizationId)?.name || 'sélectionnée'}
                </div>
              </div>
            </div>
            {/* La seule decision qui revient a l'utilisateur. Avant, l'instance
                atterrissait dans le dossier selectionne ailleurs dans l'appli,
                sans que personne ne l'ait choisi. */}
            <div className="mt-4">
              <label className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                Où ranger {(comptesACreer?.length ?? readyCount) > 1 ? 'ces instances' : 'cette instance'} ?
              </label>
              <select
                value={dossierChoisi}
                onChange={event => setDossierChoisi(event.target.value)}
                disabled={createActionLoading}
                className="w-full mt-1.5 px-3 py-2.5 rounded-lg text-sm outline-none"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                }}
              >
                <option value="__none__">Aucun dossier</option>
                {folders.map(folder => (
                  <option key={folder.id} value={folder.id}>{folder.name}</option>
                ))}
              </select>
            </div>
            <div
              className="mt-4 rounded-xl p-3 text-xs leading-relaxed"
              style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
            >
              Spectra vérifiera les proxies, respectera la limite de {COMPTES_MAX_PAR_PROXY} comptes par proxy,
              créera les instances une par une et fermera chaque fenêtre après une connexion confirmée.
              Si la capacité proxy est insuffisante, seuls les comptes pouvant recevoir un proxy seront
              traités et les autres resteront en attente.
              En cas de vérification X, le traitement se mettra en pause et laissera la fenêtre ouverte.
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowCreateConfirmation(false);
                  setComptesACreer(null);
                }}
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
