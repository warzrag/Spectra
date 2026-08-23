import React, { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, MoveRight, Search, Play, MoreVertical, Globe, Shield, Smartphone, Wifi, Circle, Copy, ExternalLink, Settings, ArrowUpDown, Tag, Monitor, UserPlus, Upload, Download, ArrowLeft, Users, FolderOpen, Edit, FileText, ChevronRight, ChevronDown, Lock, Loader2, Rocket, GripVertical, Square, KeyRound, Radio, CheckCircle2, AlertTriangle, Bot, ShieldCheck, Send, Clock, X as XIcon } from 'lucide-react';
import MoveFolderModal from '../components/MoveFolderModal';
import AssignProfileModal from '../components/AssignProfileModal';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { logActivity } from '../services/firestore-service';
import { downloadProfileFromCloud, needsCloudDownload } from '../services/profile-sync-service';
import { Profile, Folder, Team, AppSettings, Platform, ProfileStatus, BotStatus } from '../../types';
import { isLockedByOther } from '../services/profile-sync-service';
import { normalizeTweetUrl } from '../../shared/twitter-url';
import { SessionImportProgress } from '../../shared/session-import';

interface DashboardProps {
  profiles: Profile[];
  folders: Folder[];
  teams?: Team[];
  workspaceLabel?: string;
  loading: boolean;
  selectedFolderId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  settings: AppSettings;
  onCreateProfile: (profileData: any) => void;
  onUpdateProfile: (profileId: string, profileData: any) => void;
  onDeleteProfile: (profileId: string) => void;
  onLaunchProfile: (profile: any) => void;
  onBulkLaunch: (profileIds: string[]) => void;
  onOpenTweetInFolder: (profileIds: string[], tweetUrl: string) => void;
  bulkLaunching: { total: number; current: number; name: string } | null;
  isOpenPostRunning: boolean;
  onStopOpenPost: () => void;
  autoPostEnabled: boolean;
  autoPostFolderId: string | null;
  autoPostProcessing: boolean;
  autoPostQueueCount: number;
  autoPostNotice: {
    postUrl: string;
    account?: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
  } | null;
  onDismissAutoPostNotice: () => void;
  onToggleAutoPost: (folderId: string) => void;
  /* Mass post automatique : un lot toutes les N heures, de lui-meme. */
  massPostAutoEnabled: boolean;
  massPostAutoFolderId: string | null;
  massPostAutoHours: number;
  massPostAutoLastRun: number;
  onToggleMassPostAuto: (folderId: string) => void;
  onMassPostAutoRan: (quand: number) => void;
  sessionImportProgress: SessionImportProgress | null;
  onImportSessions: (content: string, fileName: string) => void;
  onStopSessionImport: () => void;
  onMoveProfile: (profileId: string, folderId: string | null) => void;
  onShowCreateModal: () => void;
  onEditProfile: (profile: Profile) => void;
  onCloneProfile: (profile: Profile) => void;
  currentDeviceName?: string | null;
  currentInstallationId?: string | null;
}

const Dashboard: React.FC<DashboardProps> = ({
  profiles,
  folders,
  teams = [],
  workspaceLabel,
  loading,
  selectedFolderId,
  onSelectFolder,
  settings,
  onCreateProfile,
  onUpdateProfile,
  onDeleteProfile,
  onLaunchProfile,
  onBulkLaunch,
  onOpenTweetInFolder,
  bulkLaunching,
  isOpenPostRunning,
  onStopOpenPost,
  autoPostEnabled,
  autoPostFolderId,
  autoPostProcessing,
  autoPostQueueCount,
  autoPostNotice,
  onDismissAutoPostNotice,
  onToggleAutoPost,
  massPostAutoEnabled,
  massPostAutoFolderId,
  massPostAutoHours,
  massPostAutoLastRun,
  onToggleMassPostAuto,
  onMassPostAutoRan,
  sessionImportProgress,
  onImportSessions,
  onStopSessionImport,
  onMoveProfile,
  onShowCreateModal,
  onEditProfile,
  onCloneProfile,
  currentDeviceName,
  currentInstallationId,
}) => {
  const { user, isAdmin, isVA } = useAuth();
  const { showToast } = useToast();
  const [searchTerm, setSearchTerm] = useState('');
  const sessionImportInputRef = useRef<HTMLInputElement>(null);
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [moveProfileIds, setMoveProfileIds] = useState<string[]>([]);
  const [activeProfiles, setActiveProfiles] = useState<string[]>([]);
  const [testingProxyProfileIds, setTestingProxyProfileIds] = useState<Set<string>>(new Set());
  const [proxyTestResults, setProxyTestResults] = useState<Record<string, {
    isHealthy: boolean;
    country: string;
    ping: number;
  }>>({});
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'created' | 'lastUsed' | 'custom'>(() => {
    return (localStorage.getItem('spectra-dashboard-sort-by') as any) || settings.sortBy || 'custom';
  });
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(() => {
    return (localStorage.getItem('spectra-dashboard-sort-order') as any) || settings.sortOrder || 'asc';
  });
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [assignProfileId, setAssignProfileId] = useState<string | null>(null);
  const [bulkAssignMode, setBulkAssignMode] = useState(false);
  const [statusMenuId, setStatusMenuId] = useState<string | null>(null);
  const [showBulkStatusMenu, setShowBulkStatusMenu] = useState(false);
  const [botStatusMenuId, setBotStatusMenuId] = useState<string | null>(null);
  const [showBulkBotStatusMenu, setShowBulkBotStatusMenu] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [tweetUrl, setTweetUrl] = useState('');

  const statusOptions: { id: ProfileStatus; label: string; color: string; bg: string }[] = [
    { id: 'loggedIn', label: 'Compte connecté', color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
    { id: 'toLogIn', label: 'À connecter', color: '#eab308', bg: 'rgba(234,179,8,0.1)' },
    { id: 'active', label: 'Active', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
    { id: 'shadowBanned', label: 'Shadow Ban', color: '#f97316', bg: 'rgba(249,115,22,0.1)' },
    { id: 'banned', label: 'Banned', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
    { id: 'none', label: 'No Status', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' },
  ];

  const botStatusOptions: { id: BotStatus; label: string; color: string; bg: string }[] = [
    { id: 'botConnected', label: 'Bot connecté', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
    { id: 'botDisconnected', label: 'Bot non connecté', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
    { id: 'none', label: 'No Status', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' },
  ];

  useEffect(() => {
    if (window.electronAPI?.profiles?.getActive) {
      window.electronAPI.profiles.getActive().then(setActiveProfiles).catch(console.error);
    }
    if (window.electronAPI?.profiles?.onActiveUpdate) {
      const unsubscribe = window.electronAPI.profiles.onActiveUpdate(setActiveProfiles);
      return () => unsubscribe();
    }
  }, []);

  useEffect(() => {
    if (openMenuId || statusMenuId || botStatusMenuId) {
      const handler = () => { setOpenMenuId(null); setStatusMenuId(null); setBotStatusMenuId(null); };
      document.addEventListener('click', handler);
      return () => document.removeEventListener('click', handler);
    }
  }, [openMenuId, statusMenuId, botStatusMenuId]);

  useEffect(() => {
    localStorage.setItem('spectra-dashboard-sort-by', sortBy);
    localStorage.setItem('spectra-dashboard-sort-order', sortOrder);
  }, [sortBy, sortOrder]);

  // Reset selection when navigating between folders
  useEffect(() => {
    setSelectedProfiles([]);
    setSearchTerm('');
    setFilterTag(null);
  }, [selectedFolderId]);

  // Drag & drop reorder handler
  const handleDrop = (targetId: string) => {
    if (!isAdmin || !dragId || dragId === targetId) return;
    setSortBy('custom');
    setSortOrder('asc');

    // Build current visual order
    const currentList = localOrder
      ? localOrder.map(id => filteredProfiles.find(p => p.id === id)).filter(Boolean) as Profile[]
      : [...filteredProfiles];

    const fromIdx = currentList.findIndex(p => p.id === dragId);
    const toIdx = currentList.findIndex(p => p.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    // Move item in the list
    const [moved] = currentList.splice(fromIdx, 1);
    currentList.splice(toIdx, 0, moved);

    // Set local order immediately (visual feedback)
    const newOrder = currentList.map(p => p.id);
    setLocalOrder(newOrder);

    // Save to Firestore in background
    newOrder.forEach((id, i) => {
      onUpdateProfile(id, { sortIndex: i });
    });

    setDragId(null);
    setDragOverId(null);
  };

  // Get all unique tags
  const allTags = Array.from(new Set(profiles.flatMap(p => p.tags || [])));

  // Get child folder IDs for hierarchical filtering
  const getChildFolderIds = (parentId: string) =>
    folders.filter(f => f.parentId === parentId).map(f => f.id);

  // Filter profiles for the instance table view
  const filteredProfiles = profiles
    .filter(profile => {
      const matchesSearch = profile.name.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesFolder = selectedFolderId === '__none__'
        ? !profile.folderId
        : selectedFolderId === null
          ? true
          : profile.folderId === selectedFolderId ||
            getChildFolderIds(selectedFolderId).includes(profile.folderId || '');
      const matchesTag = filterTag === null ? true : (profile.tags || []).includes(filterTag);
      return matchesSearch && matchesFolder && matchesTag;
    })
    .sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'custom') {
        if (localOrder) {
          const ai = localOrder.indexOf(a.id);
          const bi = localOrder.indexOf(b.id);
          cmp = (ai === -1 ? 999999 : ai) - (bi === -1 ? 999999 : bi);
        } else {
          // Use sortIndex, fallback to creation date order
          const ai = a.sortIndex ?? new Date(a.createdAt).getTime();
          const bi = b.sortIndex ?? new Date(b.createdAt).getTime();
          cmp = ai - bi;
        }
      }
      else if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortBy === 'created') cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      else if (sortBy === 'lastUsed') cmp = new Date(a.lastUsed || 0).getTime() - new Date(b.lastUsed || 0).getTime();
      return sortOrder === 'desc' ? -cmp : cmp;
    });

  const launchableVisibleProfiles = filteredProfiles.filter(profile =>
    !activeProfiles.includes(profile.id) &&
    !(user && isLockedByOther(profile, user.uid, currentDeviceName, currentInstallationId))
  );

  const handleSelectProfile = (profileId: string) => {
    if (!isAdmin && !isVA) return;
    setSelectedProfiles(prev =>
      prev.includes(profileId) ? prev.filter(id => id !== profileId) : [...prev, profileId]
    );
  };

  const handleSelectAll = () => {
    if (!isAdmin && !isVA) return;
    if (selectedProfiles.length === filteredProfiles.length) {
      setSelectedProfiles([]);
    } else {
      setSelectedProfiles(filteredProfiles.map(p => p.id));
    }
  };

  const handleBulkDelete = () => {
    if (!isAdmin) return;
    if (window.confirm(`Delete ${selectedProfiles.length} instances?`)) {
      selectedProfiles.forEach(id => onDeleteProfile(id));
      setSelectedProfiles([]);
    }
  };

  const openMoveModal = (profileIds: string[]) => {
    if (!isAdmin) return;
    setMoveProfileIds(profileIds);
    setShowMoveModal(true);
  };

  const handleMoveProfiles = (folderId: string | null) => {
    if (!isAdmin) return;
    moveProfileIds.forEach(id => onMoveProfile(id, folderId));
    showToast(`${moveProfileIds.length} instance${moveProfileIds.length > 1 ? 's' : ''} moved`, 'success');
    setSelectedProfiles([]);
    setMoveProfileIds([]);
    setShowMoveModal(false);
  };

  const toggleSort = (col: 'name' | 'created' | 'lastUsed') => {
    if (sortBy === col) setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortOrder('desc'); }
  };

  const handleImportCookies = async (profile: Profile) => {
    if (!isAdmin) return;
    setOpenMenuId(null);
    if (!window.electronAPI?.cookies) return;

    try {
      const fileContent = await window.electronAPI.cookies.selectFile();
      if (!fileContent) return;

      // Auto-detect format: JSON starts with [ or {, otherwise Netscape
      const trimmed = fileContent.trim();
      const format = (trimmed.startsWith('[') || trimmed.startsWith('{')) ? 'json' as const : 'netscape' as const;
      const result = await window.electronAPI.cookies.import(profile.id, fileContent, format);
      if (result.success) {
        showToast(`Imported ${result.count} cookies into "${profile.name}"`, 'success');
        if (user) {
          logActivity({
            userId: user.uid, userName: user.email,
            action: 'cookies_imported', targetProfileId: profile.id, targetProfileName: profile.name,
            timestamp: new Date().toISOString(),
            metadata: { count: result.count, format },
          }).catch(() => {});
        }
      }
    } catch (error) {
      console.error('Cookie import failed:', error);
      showToast('Failed to import cookies', 'error');
    }
  };

  const handleExportCookies = async (profile: Profile) => {
    if (!isAdmin) return;
    setOpenMenuId(null);
    if (!window.electronAPI?.cookies) return;

    try {
      const result = await window.electronAPI.cookies.export(profile.id);
      if (result.success && result.cookies.length > 0) {
        const data = JSON.stringify(result.cookies, null, 2);
        await window.electronAPI.cookies.saveFile(data, `${profile.name}-cookies.json`);
        if (user) {
          logActivity({
            userId: user.uid, userName: user.email,
            action: 'cookies_exported', targetProfileId: profile.id, targetProfileName: profile.name,
            timestamp: new Date().toISOString(),
            metadata: { count: result.cookies.length },
          }).catch(() => {});
        }
      } else {
        showToast('No cookies to export for this instance', 'warning');
      }
    } catch (error) {
      console.error('Cookie export failed:', error);
      showToast('Failed to export cookies', 'error');
    }
  };

  const handleAssign = (profileId: string, userId: string | null, userEmail: string | null) => {
    if (!isAdmin) return;
    onUpdateProfile(profileId, { assignedTo: userId, assignedToEmail: userEmail });
    setAssignProfileId(null);
  };

  const handleBulkAssign = (userId: string | null, userEmail: string | null) => {
    if (!isAdmin) return;
    selectedProfiles.forEach(id => {
      onUpdateProfile(id, { assignedTo: userId, assignedToEmail: userEmail });
    });
    setBulkAssignMode(false);
    setSelectedProfiles([]);
    showToast(`${selectedProfiles.length} instances assigned`, 'success');
  };

  // 'none' est ecrit tel quel, jamais en undefined : la couche Firestore retire
  // les cles undefined avant d'envoyer, si bien qu'un retour a "No Status" ne
  // partait pas et l'ancienne valeur restait affichee.
  const handleBulkStatusChange = (newStatus: ProfileStatus) => {
    if (!isAdmin) return;
    selectedProfiles.forEach(id => {
      onUpdateProfile(id, { status: newStatus });
    });
    setShowBulkStatusMenu(false);
    showToast(`Status updated for ${selectedProfiles.length} instances`, 'success');
  };

  /**
   * Designe une instance comme modele du robot pour son dossier.
   *
   * Un dossier n'en a qu'une : marquer la nouvelle demarque l'ancienne, sinon
   * deux references se disputeraient le meme dossier et la derniere ouverte
   * gagnerait, au hasard.
   *
   * Les instances du dossier qui avaient deja recu un modele sont remises a
   * zero, pour recevoir celui-ci a leur prochaine ouverture.
   */
  /**
   * Un seul lot de branding pour tout le parc.
   *
   * Un lot par dossier obligeait a le remplir autant de fois qu'il y a de
   * dossiers, et deux comptes de dossiers differents pouvaient recevoir la
   * meme photo -- ce qui est precisement ce qu'on veut eviter. Avec un lot
   * unique, on remplit une fois et aucune instance ne partage son visage avec
   * une autre, ou qu'elle soit rangee.
   */
  const LOT_UNIQUE = 'tous';

  // Le panneau de branding : tout se depose ici, rien dans l'explorateur.
  const [panneauBranding, setPanneauBranding] = useState<string | null>(null);
  const [lotBranding, setLotBranding] = useState<{
    photos: number; bannieres: number; bios: string; noms: string; lieux: string; liens: string;
    posts: string; medias: number;
  } | null>(null);
  // Le meme lot sert aux deux panneaux ; seul l'onglet ouvert change.
  const [panneauPublication, setPanneauPublication] = useState<string | null>(null);

  /**
   * Ce qui a reellement abouti, par instance.
   *
   * Les attributions disent ce qui a ete tire, pas ce qui est parti : le
   * tirage a lieu avant l'ouverture du navigateur. Sans cette trace, rien ne
   * distingue un compte brande d'un compte dont le branding a echoue.
   */
  const [resultatsActions, setResultatsActions] = useState<Record<string, {
    branding?: { statut: string; quand: string; message: string };
    post?: { statut: string; quand: string; message: string; apercu?: string | null };
    ecartee?: { quand: string; raison: string } | null;
  }>>({});

  const basculerEcartee = async (profil: any) => {
    const dejaEcartee = Boolean(resultatsActions[profil.id]?.ecartee);
    try {
      const tous = await (window as any).electronAPI?.branding
        ?.setSkipped(LOT_UNIQUE, profil.id, !dejaEcartee, 'Mise de côté à la main');
      setResultatsActions(tous || {});
      showToast(
        dejaEcartee
          ? `${profil.name} revient dans les lots`
          : `${profil.name} est mise de côté — les lots la sauteront`,
        'success'
      );
    } catch {
      showToast('Impossible de changer cet état', 'error');
    }
  };

  const chargerResultats = async () => {
    try {
      const tous = await (window as any).electronAPI?.branding?.results(LOT_UNIQUE);
      setResultatsActions(tous || {});
    } catch {}
  };
  useEffect(() => { chargerResultats(); }, []);

  const ouvrirPanneauBranding = async () => {
    try {
      const etat = await (window as any).electronAPI?.branding?.read(LOT_UNIQUE);
      setLotBranding(etat);
      setPanneauBranding(LOT_UNIQUE);
    } catch {
      showToast('Lot de branding illisible', 'error');
    }
  };

  const ouvrirPanneauPublication = async () => {
    try {
      const etat = await (window as any).electronAPI?.branding?.read(LOT_UNIQUE);
      setLotBranding(etat);
      setPanneauPublication(LOT_UNIQUE);
    } catch {
      showToast('Lot de publication illisible', 'error');
    }
  };

  const enregistrerTextesBranding = async () => {
    const lot = panneauBranding || panneauPublication;
    if (!lot || !lotBranding) return;
    try {
      const etat = await (window as any).electronAPI?.branding?.saveTexts(lot, {
        bios: lotBranding.bios,
        noms: lotBranding.noms,
        lieux: lotBranding.lieux,
        liens: lotBranding.liens,
        posts: lotBranding.posts,
      });
      setLotBranding(etat);
      showToast('Textes enregistrés', 'success');
    } catch {
      showToast('Enregistrement impossible', 'error');
    }
  };

  const ajouterImagesBranding = async (sorte: 'photos' | 'bannieres' | 'medias') => {
    const lot = panneauBranding || panneauPublication;
    if (!lot) return;
    try {
      const reponse = await (window as any).electronAPI?.branding?.addImages(lot, sorte);
      if (reponse?.etat) setLotBranding(reponse.etat);
      if (reponse?.ajoutees) showToast(`${reponse.ajoutees} image(s) ajoutée(s)`, 'success');
    } catch {
      showToast('Ajout impossible', 'error');
    }
  };

  // Branding a la chaine : une instance a la fois, avec un arret possible.
  const [brandingEnCours, setBrandingEnCours] = useState<
    { fait: number; total: number; nom: string } | null
  >(null);
  const arretBrandingRef = useRef(false);
  // Combien de fenetres ouvertes en meme temps. Chaque instance a son profil et
  // son proxy : elles sont independantes, rien n'oblige a les faire une par une.
  //
  // Un reglage par action, et non un seul partage : un branding pose une photo
  // et deux champs, un mass post televerse une video de 40 Mo et attend X
  // pendant des minutes. Ils ne demandent pas la meme prudence.
  //
  // Et ils tiennent au redemarrage : retomber a 4 a chaque ouverture obligeait
  // a le refaire chaque fois.
  const lireReglage = (cle: string) => {
    const v = Number(localStorage.getItem(cle));
    return Number.isFinite(v) && v > 0 ? v : 4;
  };
  const [parallelesBranding, setParallelesBranding] = useState(() =>
    lireReglage('spectra-paralleles-branding'));
  const [parallelesPost, setParallelesPost] = useState(() =>
    lireReglage('spectra-paralleles-post'));

  useEffect(() => {
    localStorage.setItem('spectra-paralleles-branding', String(parallelesBranding));
  }, [parallelesBranding]);
  useEffect(() => {
    localStorage.setItem('spectra-paralleles-post', String(parallelesPost));
  }, [parallelesPost]);

  const arreterBranding = () => {
    arretBrandingRef.current = true;
    showToast('Arrêt demandé — la fenêtre en cours va se terminer', 'info');
  };

  /**
   * Deroule une action sur toutes les instances selectionnees.
   *
   * Le branding et la publication font exactement la meme chose : ouvrir des
   * fenetres par paquets, prendre la suivante des qu'une place se libere, et
   * pouvoir s'arreter en cours. Seul l'appel du milieu differe -- les deux
   * partagent donc cette boucle plutot que d'en avoir chacune une copie qui
   * derive de l'autre.
   */
  const enChaine = async (
    intitule: string,
    action: (profil: any, place: number) => Promise<any>,
    /* Sans liste, ce sont les instances cochees. Le mass post automatique,
       lui, tourne sans que personne n'ait rien coche : il passe la liste du
       dossier. */
    cibleIds?: string[],
    /* Combien de fenetres en meme temps. Le branding et le mass post ont
       chacun le leur : ils ne demandent pas la meme prudence. */
    fenetres?: number
  ) => {
    const ids = cibleIds ?? selectedProfiles;
    const cibles = profiles.filter(profil => ids.includes(profil.id));
    // Les instances mises de cote sont sautees, mais on dit combien : un lot
    // qui traite moins d'instances que coche doit s'expliquer.
    const traitables = cibles.filter(profil => !resultatsActions[profil.id]?.ecartee);
    const sautees = cibles.length - traitables.length;
    if (sautees > 0) {
      showToast(`${sautees} instance(s) mise(s) de côté — sautée(s)`, 'info');
    }
    if (traitables.length === 0) {
      if (sautees > 0) showToast('Toutes les instances cochées sont mises de côté', 'warning');
      return;
    }

    arretBrandingRef.current = false;
    let reussis = 0;
    let rates = 0;
    let fait = 0;
    const enAttente = [...traitables];

    /**
     * Chaque poste prend l'instance suivante des qu'il a fini la sienne.
     *
     * Une file partagee plutot que des paquets fixes : si un compte demande
     * trente secondes et un autre cinq, personne n'attend pour rien.
     */
    const poste = async (place: number) => {
      while (!arretBrandingRef.current) {
        const profil = enAttente.shift();
        if (!profil) return;
        setBrandingEnCours({ fait, total: traitables.length, nom: profil.name });
        try {
          /* Rapatrier le profil depuis le cloud avant de l'ouvrir, exactement
             comme le fait le bouton Open.

             Un lot passait directement au lanceur, sans cette etape. Sur le
             poste ou les profils sont a jour, cela ne se voyait pas. Sur une
             machine qui ne les avait pas encore -- le VPS 128, le 23 aout
             2026 -- les instances arrivaient sur X deconnectees : leur
             session vit dans le cloud, pas sur le disque. Ouvrir la meme
             instance a la main la connectait, parce que ce chemin-la
             telechargeait d'abord.

             Un echec de telechargement ne doit pas arreter le lot : on
             tente quand meme, avec ce qu'il y a sur place. */
          try {
            if (await needsCloudDownload(profil)) {
              await downloadProfileFromCloud(profil, () => {});
            }
          } catch (erreurTelechargement) {
            showToast(
              `${profil.name} : téléchargement du profil impossible, ouverture avec la copie locale`,
              'warning'
            );
          }
          const resultat = await action(profil, place);
          if (resultat?.status === 'success') reussis++;
          else {
            rates++;
            showToast(`${profil.name} : ${resultat?.message || 'non confirmé'}`, 'warning');
          }
        } catch {
          rates++;
        }
        fait++;
        setBrandingEnCours({ fait, total: traitables.length, nom: profil.name });
        // Rafraichir au fil de l'eau : le tableau se remplit sous les yeux,
        // plutot que tout d'un coup a la fin.
        chargerResultats();
      }
    };

    const postes = Math.max(1, Math.min((fenetres ?? parallelesBranding), traitables.length));
    await Promise.all(Array.from({ length: postes }, (_, place) => poste(place)));
    setBrandingEnCours(null);
    chargerResultats();
    showToast(
      `${intitule} terminé — ${reussis} réussi(s), ${rates} en échec` +
      (arretBrandingRef.current ? ' (arrêté en cours)' : ''),
      rates === 0 ? 'success' : 'warning'
    );
  };

  /**
   * Compte les posts comme le fait le tirage, pas comme des lignes.
   *
   * Un post porte souvent ses propres retours a la ligne ; une ligne vide au
   * milieu fait partie du texte. Une ligne ne contenant que --- separe deux
   * posts, et sans separateur on retombe sur une ligne par post.
   */
  const compterPosts = (texte: string): number => {
    if (/^\s*---\s*$/m.test(texte)) {
      return texte.split(/^\s*---\s*$/m).filter(bloc => bloc.trim()).length;
    }
    return texte.split('\n').filter(ligne => ligne.trim()).length;
  };

  const lancerBranding = () => enChaine('Branding', (profil, place) =>
    (window as any).electronAPI?.branding?.apply(profil, {
      index: place,
      total: parallelesBranding,
    })
  );

  const lancerPublication = (cibleIds?: string[]) => enChaine('Publication', (profil, place) =>
    (window as any).electronAPI?.branding?.post(profil, {
      index: place,
      total: parallelesPost,
    }), cibleIds, parallelesPost
  );

  /* ------------------------------------------------------------------ */

  const definirModeleBot = (profil: any) => {
    if (!isAdmin) return;
    if (!profil.folderId) {
      showToast('Range d’abord cette instance dans un dossier', 'warning');
      return;
    }
    for (const autre of profiles) {
      if (autre.deleted || autre.folderId !== profil.folderId) continue;
      if (autre.id === profil.id) continue;
      if (autre.botTemplate) onUpdateProfile(autre.id, { botTemplate: false });
      if (autre.botTemplateApplied) onUpdateProfile(autre.id, { botTemplateApplied: '' });
    }
    onUpdateProfile(profil.id, { botTemplate: true, botTemplateApplied: '' });
    showToast(
      `${profil.name} est le modèle du robot pour ce dossier — ouvre-la une fois pour publier ses réglages`,
      'success'
    );
  };

  const handleBulkBotStatusChange = (newStatus: BotStatus) => {
    if (!isAdmin) return;
    selectedProfiles.forEach(id => {
      onUpdateProfile(id, { botStatus: newStatus });
    });
    setShowBulkBotStatusMenu(false);
    showToast(`Bot status updated for ${selectedProfiles.length} instances`, 'success');
  };

  const getConnectionInfo = (profile: any) => {
    if (profile.connectionType === 'iphone') return { icon: <Smartphone size={14} />, label: 'iPhone 4G', color: '#60a5fa' };
    if (profile.connectionType === 'wifi') return { icon: <Wifi size={14} />, label: 'WiFi', color: '#34d399' };
    if (profile.connectionType === 'proxy' && profile.proxy) return { icon: <Shield size={14} />, label: profile.proxy.host || 'Proxy', color: '#a78bfa' };
    return { icon: <Globe size={14} />, label: 'Direct', color: 'var(--text-muted)' };
  };

  const handleTestProfileProxy = async (profile: Profile) => {
    if (!profile.proxy?.host || !window.electronAPI?.proxy?.test) {
      showToast(`"${profile.name}" n'a pas de proxy à tester`, 'warning');
      return;
    }

    setTestingProxyProfileIds(previous => new Set(previous).add(profile.id));
    const startedAt = performance.now();
    try {
      const result = await window.electronAPI.proxy.test(profile.proxy);
      const proxyResult = result as unknown as {
        isHealthy?: boolean;
        country?: string | null;
      };
      const configuredProxy = profile.proxy as typeof profile.proxy & { country?: string };
      const isHealthy = typeof result === 'boolean' ? result : Boolean(proxyResult?.isHealthy);
      const ping = Math.max(1, Math.round(performance.now() - startedAt));
      const country = String(proxyResult?.country || configuredProxy.country || '--').toUpperCase();
      setProxyTestResults(previous => ({
        ...previous,
        [profile.id]: { isHealthy, country, ping },
      }));
      showToast(
        isHealthy
          ? `"${profile.name}" : proxy fonctionnel · ${country} · ${ping} ms`
          : `"${profile.name}" : proxy inaccessible · ${ping} ms`,
        isHealthy ? 'success' : 'error'
      );
    } catch (error) {
      console.error(`Proxy test failed for ${profile.name}:`, error);
      showToast(`"${profile.name}" : échec du test proxy`, 'error');
    } finally {
      setTestingProxyProfileIds(previous => {
        const next = new Set(previous);
        next.delete(profile.id);
        return next;
      });
    }
  };

  const getOSLabel = (os?: string) => {
    if (os === 'windows') return 'Windows';
    if (os === 'macos') return 'macOS';
    if (os === 'linux') return 'Linux';
    return '-';
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const truncateUrl = (url: string) => {
    try {
      const u = new URL(url);
      return u.hostname;
    } catch {
      return url;
    }
  };

  const SortIcon = ({ col }: { col: 'name' | 'created' | 'lastUsed' }) => (
    <ArrowUpDown size={10} style={{ opacity: sortBy === col ? 1 : 0.3, marginLeft: 4 }} />
  );

  const platformInfo: Record<string, { icon: string; label: string }> = {
    twitter: { icon: '𝕏', label: 'Twitter' },
    instagram: { icon: '📷', label: 'Instagram' },
    tiktok: { icon: '🎵', label: 'TikTok' },
    reddit: { icon: '🔴', label: 'Reddit' },
    onlyfans: { icon: '💙', label: 'OnlyFans' },
    telegram: { icon: '✈️', label: 'Telegram' },
    other: { icon: '🌐', label: 'Other' },
  };

  const getPlatformSummary = (folderProfiles: Profile[]) => {
    const counts: Record<string, number> = {};
    folderProfiles.forEach(p => {
      const key = p.platform || 'other';
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ ...(platformInfo[key] || platformInfo.other), count }));
  };

  const assignProfile = assignProfileId ? profiles.find(p => p.id === assignProfileId) : null;

  // Current folder info for header
  const currentFolder = selectedFolderId && selectedFolderId !== '__none__'
    ? folders.find(f => f.id === selectedFolderId)
    : null;
  const currentFolderProfileIds = currentFolder
    ? profiles
      .filter(profile =>
        profile.folderId === currentFolder.id ||
        getChildFolderIds(currentFolder.id).includes(profile.folderId || '')
      )
      .map(profile => profile.id)
    : [];
  const selectedFolderProfileIds = selectedProfiles.filter(profileId =>
    currentFolderProfileIds.includes(profileId)
  );
  const normalizedTweetUrl = normalizeTweetUrl(tweetUrl);


  /* Mass post automatique                                               */
  /*                                                                     */
  /* Un lot toutes les N heures sur le dossier ouvert, sans que personne  */
  /* n'ait rien a cocher ni a cliquer. A ne pas confondre avec le bouton  */
  /* Auto Post voisin : celui-la declenche Open Post APRES une            */
  /* publication du bot ; celui-ci publie de lui-meme.                    */
  /*                                                                     */
  /* L'heure du dernier lot est enregistree dans les reglages AVANT de    */
  /* lancer, jamais apres : si Spectra ferme au milieu, on ne repart pas  */
  /* en boucle a la reouverture.                                         */
  /* ------------------------------------------------------------------ */
  const massPostAutoEnCoursRef = useRef(false);

  const heuresMassPostAuto = Math.max(1, Number(massPostAutoHours) || 6);

  const lancerMassPostAuto = async () => {
    if (massPostAutoEnCoursRef.current || brandingEnCours) return;
    const cibles = launchableVisibleProfiles.map(p => p.id);
    if (!cibles.length) return;

    massPostAutoEnCoursRef.current = true;
    try {
      onMassPostAutoRan?.(Date.now());
      showToast(`Mass post automatique : ${cibles.length} instance(s)`, 'info');
      await lancerPublication(cibles);
    } finally {
      massPostAutoEnCoursRef.current = false;
    }
  };

  useEffect(() => {
    if (!massPostAutoEnabled || !currentFolder || massPostAutoFolderId !== currentFolder.id) return;

    const verifier = () => {
      const dernier = Number(massPostAutoLastRun || 0);
      const ecoule = Date.now() - dernier;
      if (dernier && ecoule < heuresMassPostAuto * 3600 * 1000) return;
      void lancerMassPostAuto();
    };

    /* Un premier controle a l'ouverture rattrape un lot manque pendant que
       Spectra etait ferme, puis un controle par minute suffit largement. */
    const depart = setTimeout(verifier, 5000);
    const minuteur = setInterval(verifier, 60000);
    return () => { clearTimeout(depart); clearInterval(minuteur); };
  }, [
    massPostAutoEnabled,
    massPostAutoFolderId,
    massPostAutoLastRun,
    heuresMassPostAuto,
    currentFolder?.id,
    launchableVisibleProfiles.length,
  ]);
  useEffect(() => {
    if (
      autoPostNotice?.postUrl &&
      autoPostEnabled &&
      autoPostFolderId === currentFolder?.id
    ) {
      setTweetUrl(autoPostNotice.postUrl);
    }
  }, [
    autoPostNotice?.postUrl,
    autoPostEnabled,
    autoPostFolderId,
    currentFolder?.id,
  ]);

  // ============================================================
  // VIEW 1: Model Grid (when no folder selected)
  // ============================================================
  if (selectedFolderId === null) {
    const unassignedProfiles = profiles.filter(p => !p.folderId);
    const gridSearchTerm = searchTerm.toLowerCase();
    // Only show root folders in grid view
    const rootFolders = folders.filter(f => !f.parentId);
    const filteredFolders = gridSearchTerm
      ? rootFolders.filter(f => {
          const childIds = getChildFolderIds(f.id);
          const fp = profiles.filter(p => p.folderId === f.id || childIds.includes(p.folderId || ''));
          return f.name.toLowerCase().includes(gridSearchTerm) || fp.some(p => p.name.toLowerCase().includes(gridSearchTerm));
        })
      : rootFolders;
    const filteredUnassigned = gridSearchTerm
      ? unassignedProfiles.filter(p => p.name.toLowerCase().includes(gridSearchTerm))
      : unassignedProfiles;
    const workspaceTitle = workspaceLabel?.includes(' — ')
      ? workspaceLabel.split(' — ').pop()
      : workspaceLabel;

    const renderFolderCard = (folder: Folder) => {
      const childIds = getChildFolderIds(folder.id);
      const folderProfiles = profiles.filter(p => p.folderId === folder.id || childIds.includes(p.folderId || ''));
      const activeCount = folderProfiles.filter(p => activeProfiles.includes(p.id)).length;
      const lastActivity = folderProfiles.reduce((max, p) => {
        const t = p.lastUsed || p.createdAt || '';
        return t > max ? t : max;
      }, '');

      return (
        <button
          key={folder.id}
          onClick={() => onSelectFolder(folder.id)}
          className="text-left p-5 rounded-xl transition-all group"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'var(--accent)';
            e.currentTarget.style.boxShadow = '0 4px 20px rgba(99, 102, 241, 0.1)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'var(--border-default)';
            e.currentTarget.style.boxShadow = 'none';
          }}
        >
          <div className="flex items-start justify-between mb-3">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center text-xl"
              style={{ background: folder.color ? `${folder.color}20` : 'var(--bg-elevated)' }}
            >
              <span style={{ color: folder.color }}>{folder.icon || '\uD83D\uDCC1'}</span>
            </div>
            {activeCount > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}>
                <Circle size={6} className="fill-current status-dot-active" />
                {activeCount} active
              </span>
            )}
          </div>

          <h3 className="text-[14px] font-semibold truncate mb-1" style={{ color: 'var(--text-primary)' }}>
            {folder.name}
            {childIds.length > 0 && (
              <span className="ml-1.5 text-[10px] font-normal" style={{ color: 'var(--text-muted)' }}>
                ({childIds.length} sub)
              </span>
            )}
          </h3>

          <div className="flex items-center gap-3 text-[12px] mb-2" style={{ color: 'var(--text-muted)' }}>
            <span className="flex items-center gap-1">
              <Users size={12} />
              {folderProfiles.length} instance{folderProfiles.length !== 1 ? 's' : ''}
            </span>
            {lastActivity && (
              <span>{formatDate(lastActivity)}</span>
            )}
          </div>

          {folderProfiles.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {getPlatformSummary(folderProfiles).slice(0, 4).map(p => (
                <span key={p.label} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                  {p.icon} {p.count}
                </span>
              ))}
            </div>
          )}
        </button>
      );
    };

    const renderUnassignedCard = (items: Profile[], key = 'unassigned') => (
      <button
        key={key}
        onClick={() => onSelectFolder('__none__')}
        className="text-left p-5 rounded-xl transition-all"
        style={{
          background: 'var(--bg-surface)',
          border: '1px dashed var(--border-default)',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = 'var(--text-muted)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = 'var(--border-default)';
        }}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center text-xl" style={{ background: 'var(--bg-elevated)' }}>
            <FolderOpen size={20} style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>
        <h3 className="text-[14px] font-semibold truncate mb-1" style={{ color: 'var(--text-secondary)' }}>
          Unassigned
        </h3>
        <div className="flex items-center gap-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
          <Users size={12} />
          {items.length} instance{items.length !== 1 ? 's' : ''}
        </div>
      </button>
    );

    if (loading) {
      return (
        <div className="h-full flex items-center justify-center">
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Loading...</div>
        </div>
      );
    }

    return (
      <div className="h-full flex flex-col">
        {/* Header */}
        <header className="px-6 py-4 flex items-center justify-between gap-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div>
            <h1 className="text-[18px] font-bold" style={{ color: 'var(--text-primary)' }}>
              {workspaceTitle || 'Folders'}
            </h1>
            <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {filteredFolders.length} folder{filteredFolders.length !== 1 ? 's' : ''} &middot; {profiles.length} instance{profiles.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="relative w-64">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Search folders & instances..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 rounded-lg text-[13px]"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            />
          </div>
        </header>

        {/* Grid */}
        <div className="flex-1 overflow-auto p-6">
          {filteredFolders.length === 0 && filteredUnassigned.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <div className="w-20 h-20 rounded-2xl flex items-center justify-center" style={{ background: 'var(--bg-elevated)' }}>
                <FolderOpen size={36} style={{ color: 'var(--text-muted)' }} />
              </div>
              <div className="text-center">
                <p className="text-[14px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>No folders yet</p>
                <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  Create a folder in the sidebar to get started
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredFolders.map(renderFolderCard)}
              {filteredUnassigned.length > 0 && renderUnassignedCard(filteredUnassigned)}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ============================================================
  // VIEW 2: Instance Table (when a folder is selected)
  // ============================================================
  return (
    <div className="h-full flex flex-col">
      {autoPostNotice && autoPostFolderId === currentFolder?.id && (
        <div
          className="fixed top-5 right-5 z-[200] w-[390px] max-w-[calc(100vw-2.5rem)] rounded-2xl p-4 shadow-2xl"
          style={{
            background: 'linear-gradient(145deg, rgba(18, 20, 30, 0.98), rgba(10, 12, 20, 0.98))',
            border: `1px solid ${
              autoPostNotice.status === 'completed'
                ? 'rgba(74, 222, 128, 0.55)'
                : autoPostNotice.status === 'failed'
                  ? 'rgba(248, 113, 113, 0.55)'
                  : 'rgba(129, 140, 248, 0.55)'
            }`,
          }}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{
                background: autoPostNotice.status === 'completed'
                  ? 'rgba(34, 197, 94, 0.15)'
                  : autoPostNotice.status === 'failed'
                    ? 'rgba(239, 68, 68, 0.15)'
                    : 'rgba(99, 102, 241, 0.18)',
                color: autoPostNotice.status === 'completed'
                  ? '#4ade80'
                  : autoPostNotice.status === 'failed'
                    ? '#f87171'
                    : '#a5b4fc',
              }}
            >
              {autoPostNotice.status === 'processing' ? (
                <Loader2 size={20} className="animate-spin" />
              ) : autoPostNotice.status === 'completed' ? (
                <CheckCircle2 size={20} />
              ) : autoPostNotice.status === 'failed' ? (
                <AlertTriangle size={20} />
              ) : (
                <Radio size={20} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>
                {autoPostNotice.status === 'pending'
                  ? 'Nouveau post reçu — en attente'
                  : autoPostNotice.status === 'processing'
                    ? 'Open Post — traitement en cours'
                    : autoPostNotice.status === 'completed'
                      ? 'Open Post terminé'
                      : 'Open Post — échec'}
              </div>
              {autoPostNotice.account && (
                <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  Publication de @{autoPostNotice.account}
                </div>
              )}
              <div
                className="text-[11px] mt-2 px-2.5 py-2 rounded-lg truncate"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}
                title={autoPostNotice.postUrl}
              >
                {autoPostNotice.postUrl}
              </div>
            </div>
            {autoPostNotice.status === 'failed' && (
              <button
                type="button"
                onClick={onDismissAutoPostNotice}
                className="p-1 rounded-md transition-colors shrink-0"
                style={{ color: 'var(--text-muted)' }}
                aria-label="Fermer la notification"
                title="Fermer"
              >
                <XIcon size={17} />
              </button>
            )}
          </div>
        </div>
      )}
      {/* Folder Header with Back button */}
      <header className="px-5 py-3 flex items-center justify-between gap-4 flex-wrap" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <button
            onClick={() => onSelectFolder(null)}
            className="p-1.5 rounded-lg transition-colors shrink-0"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <ArrowLeft size={18} />
          </button>

          {currentFolder ? (
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-lg" style={{ color: currentFolder.color }}>{currentFolder.icon || '\uD83D\uDCC1'}</span>
              <h2 className="text-[15px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{currentFolder.name}</h2>
            </div>
          ) : (
            <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>Unassigned Instances</h2>
          )}

          <div className="relative flex-1 max-w-xs ml-3">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Search instances..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 rounded-lg text-[13px]"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <input
            ref={sessionImportInputRef}
            type="file"
            accept=".txt,.json,.jsonl,text/plain,application/json"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              try {
                const content = await file.text();
                onImportSessions(content, file.name);
              } catch {
                showToast('Impossible de lire le fichier de sessions', 'error');
              }
            }}
          />
          <button
            type="button"
            onClick={() => sessionImportInputRef.current?.click()}
            disabled={!!bulkLaunching || sessionImportProgress?.running}
            className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: 'rgba(99,102,241,0.10)',
              border: '1px solid rgba(129,140,248,0.55)',
              color: '#a5b4fc',
            }}
            title="Importer des sessions X depuis un fichier séparé"
          >
            <KeyRound size={14} />
            {sessionImportProgress?.running ? 'Import en cours…' : 'Import sessions'}
          </button>
          {/* Le lot de branding se remplit quand on veut, sans rien cocher :
              c'est une reserve commune a tout le parc, pas une action sur une
              selection. */}
          {isAdmin && (
            <button
              onClick={ouvrirPanneauBranding}
              className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-semibold transition-colors"
              style={{
                background: 'rgba(34,197,94,0.12)',
                border: '1px solid #22c55e',
                color: '#22c55e',
              }}
              title="Photos, bannières, noms, bios, liens et lieux — un seul lot pour tout le parc"
            >
              <Tag size={14} />
              Branding
            </button>
          )}
          {/* Meme logique : la reserve de posts se remplit sans rien cocher. */}
          {isAdmin && (
            <button
              onClick={ouvrirPanneauPublication}
              className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-semibold transition-colors"
              style={{
                background: 'rgba(56,189,248,0.12)',
                border: '1px solid #38bdf8',
                color: '#38bdf8',
              }}
              title="Un post par instance, tiré au sort dans la réserve — jamais deux fois le même"
            >
              <Send size={14} />
              Mass post
            </button>
          )}
          {launchableVisibleProfiles.length > 0 && (
            <button
              onClick={() => onBulkLaunch(launchableVisibleProfiles.map(profile => profile.id))}
              disabled={!!bulkLaunching}
              className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
              style={{ background: 'var(--success-subtle, rgba(34,197,94,0.1))', border: '1px solid var(--success, #22c55e)', color: 'var(--success, #22c55e)' }}
              title="Open every available instance currently shown"
            >
              {bulkLaunching ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {bulkLaunching.current}/{bulkLaunching.total}
                </>
              ) : (
                <>
                  <Rocket size={14} />
                  Open visible ({launchableVisibleProfiles.length})
                </>
              )}
            </button>
          )}

          {isAdmin && selectedProfiles.length > 0 && (
            <>
              <button
                onClick={() => onBulkLaunch(selectedProfiles)}
                disabled={!!bulkLaunching}
                className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                style={{ background: 'var(--success-subtle, rgba(34,197,94,0.1))', border: '1px solid var(--success, #22c55e)', color: 'var(--success, #22c55e)' }}
              >
                {bulkLaunching ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    {bulkLaunching.current}/{bulkLaunching.total}
                  </>
                ) : (
                  <>
                    <Rocket size={14} />
                    Open selected ({selectedProfiles.length})
                  </>
                )}
              </button>
              <button
                onClick={() => openMoveModal(selectedProfiles)}
                className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
              >
                <MoveRight size={14} />
                Move ({selectedProfiles.length})
              </button>
              {isAdmin && (
                <button
                  onClick={() => setBulkAssignMode(true)}
                  className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                  style={{ background: 'var(--accent-subtle)', border: '1px solid var(--accent)', color: 'var(--accent-light)' }}
                >
                  <UserPlus size={14} />
                  Assign ({selectedProfiles.length})
                </button>
              )}
              {isAdmin && brandingEnCours && (
                <button
                  onClick={brandingEnCours ? arreterBranding : lancerBranding}
                  className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                  style={{
                    background: brandingEnCours ? 'var(--danger-subtle)' : 'var(--bg-elevated)',
                    border: `1px solid ${brandingEnCours ? 'var(--danger)' : 'var(--border-default)'}`,
                    color: brandingEnCours ? 'var(--danger)' : 'var(--text-secondary)',
                  }}
                  title="Photo, bannière, nom, bio et lieu — une instance à la fois"
                >
                  {brandingEnCours ? (
                    <>
                      <Square size={14} />
                      Arrêter — {brandingEnCours.fait}/{brandingEnCours.total} ({brandingEnCours.nom})
                    </>
                  ) : (
                    <>
                      <Tag size={14} />
                      Brander ({selectedProfiles.length})
                    </>
                  )}
                </button>
              )}
              <div className="relative">
                <button
                  onClick={() => setShowBulkStatusMenu(!showBulkStatusMenu)}
                  className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
                >
                  <Circle size={14} />
                  Status ({selectedProfiles.length})
                </button>
                {showBulkStatusMenu && (
                  <div
                    className="absolute right-0 top-full mt-1 rounded-lg shadow-xl z-20 py-1 min-w-[140px]"
                    style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)' }}
                    onClick={e => e.stopPropagation()}
                  >
                    {statusOptions.map(s => (
                      <button
                        key={s.id}
                        onClick={() => handleBulkStatusChange(s.id)}
                        className="w-full px-3 py-1.5 text-[12px] text-left flex items-center gap-2 transition-colors"
                        style={{ color: 'var(--text-secondary)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="relative">
                <button
                  onClick={() => setShowBulkBotStatusMenu(!showBulkBotStatusMenu)}
                  className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
                >
                  <Bot size={14} />
                  Bot ({selectedProfiles.length})
                </button>
                {showBulkBotStatusMenu && (
                  <div
                    className="absolute right-0 top-full mt-1 rounded-lg shadow-xl z-20 py-1 min-w-[160px]"
                    style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)' }}
                    onClick={e => e.stopPropagation()}
                  >
                    {botStatusOptions.map(s => (
                      <button
                        key={s.id}
                        onClick={() => handleBulkBotStatusChange(s.id)}
                        className="w-full px-3 py-1.5 text-[12px] text-left flex items-center gap-2 transition-colors"
                        style={{ color: 'var(--text-secondary)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {isAdmin && (
                <button
                  onClick={handleBulkDelete}
                  className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                  style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}
                >
                  <Trash2 size={14} />
                  Delete ({selectedProfiles.length})
                </button>
              )}
            </>
          )}
          {isVA && selectedProfiles.length > 0 && (
            <button
              onClick={() => onBulkLaunch(selectedProfiles)}
              disabled={!!bulkLaunching}
              className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
              style={{ background: 'var(--success-subtle, rgba(34,197,94,0.1))', border: '1px solid var(--success, #22c55e)', color: 'var(--success, #22c55e)' }}
            >
              {bulkLaunching ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {bulkLaunching.current}/{bulkLaunching.total}
                </>
              ) : (
                <>
                  <Rocket size={14} />
                  Open selected ({selectedProfiles.length})
                </>
              )}
            </button>
          )}
          <span className="text-[12px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {filteredProfiles.length} instance{filteredProfiles.length !== 1 ? 's' : ''}
          </span>
        </div>
      </header>

      {sessionImportProgress && (
        <div
          className="px-5 py-2.5 flex items-center gap-3"
          style={{ borderBottom: '1px solid var(--border-subtle)', background: 'rgba(99,102,241,0.06)' }}
        >
          {sessionImportProgress.running && <Loader2 size={15} className="animate-spin shrink-0" style={{ color: '#a5b4fc' }} />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3 text-[12px]">
              <span className="truncate font-medium" style={{ color: 'var(--text-primary)' }}>
                {sessionImportProgress.username ? `@${sessionImportProgress.username} — ` : ''}
                {sessionImportProgress.message}
              </span>
              <span className="tabular-nums shrink-0" style={{ color: 'var(--text-muted)' }}>
                {sessionImportProgress.current}/{sessionImportProgress.total}
              </span>
            </div>
            <div className="h-1 mt-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${sessionImportProgress.total
                    ? Math.round((sessionImportProgress.current / sessionImportProgress.total) * 100)
                    : 0}%`,
                  background: sessionImportProgress.status === 'failed' ? '#ef4444' : '#818cf8',
                }}
              />
            </div>
          </div>
          {sessionImportProgress.running && (
            <button
              type="button"
              onClick={onStopSessionImport}
              className="px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 text-[12px] font-medium shrink-0"
              style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}
            >
              <Square size={12} fill="currentColor" />
              Arrêter l’import
            </button>
          )}
        </div>
      )}

      {currentFolder && (
        <form
          className="px-5 py-2.5 flex items-center gap-2"
          style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!normalizedTweetUrl || selectedFolderProfileIds.length === 0 || bulkLaunching) return;
            onOpenTweetInFolder(selectedFolderProfileIds, normalizedTweetUrl);
          }}
        >
          <ExternalLink size={15} className="shrink-0" style={{ color: 'var(--accent-light)' }} />
          <input
            type="url"
            value={tweetUrl}
            onChange={(event) => setTweetUrl(event.target.value)}
            placeholder="https://x.com/account/status/..."
            aria-label="X post URL"
            className="flex-1 min-w-0 px-3 py-1.5 rounded-lg text-[13px]"
            style={{
              background: 'var(--bg-elevated)',
              border: `1px solid ${tweetUrl && !normalizedTweetUrl ? 'var(--danger)' : 'var(--border-default)'}`,
              color: 'var(--text-primary)',
            }}
          />
          <button
            type="submit"
            disabled={!normalizedTweetUrl || selectedFolderProfileIds.length === 0 || !!bulkLaunching}
            className="h-8 px-3 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            style={{ background: 'var(--accent)', color: '#fff' }}
            title={`Open this X post in ${selectedFolderProfileIds.length} selected instance${selectedFolderProfileIds.length !== 1 ? 's' : ''}`}
          >
            {bulkLaunching ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
            Open post ({selectedFolderProfileIds.length})
          </button>
          {isOpenPostRunning && (
            <button
              type="button"
              onClick={onStopOpenPost}
              className="h-8 px-3 rounded-lg flex items-center gap-1.5 text-[13px] font-semibold transition-colors shrink-0"
              style={{
                background: 'var(--danger-subtle)',
                border: '1px solid var(--danger)',
                color: 'var(--danger)',
              }}
              title="Stop all Open post actions and close the current instance"
            >
              <Square size={13} fill="currentColor" />
              Arrêter tout
            </button>
          )}
          <button
            type="button"
            onClick={() => onToggleAutoPost(currentFolder.id)}
            className="h-8 px-3 rounded-lg flex items-center gap-1.5 text-[13px] font-semibold transition-colors shrink-0"
            style={
              autoPostEnabled && autoPostFolderId === currentFolder.id
                ? {
                    background: 'rgba(34, 197, 94, 0.12)',
                    border: '1px solid #22c55e',
                    color: '#4ade80',
                  }
                : {
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-secondary)',
                  }
            }
            title="Déclencher automatiquement Open Post après une publication VenusBot"
          >
            {autoPostProcessing && autoPostFolderId === currentFolder.id
              ? <Loader2 size={14} className="animate-spin" />
              : <Radio size={14} />}
            {autoPostEnabled && autoPostFolderId === currentFolder.id
              ? autoPostProcessing
                ? 'Auto Post — traitement'
                : `Auto Post — en écoute${autoPostQueueCount ? ` (${autoPostQueueCount})` : ''}`
              : 'Auto Post — OFF'}
          </button>

          {/* Mass post automatique. Voisin d'Auto Post mais rien a voir :
              Auto Post reagit a une publication du bot, celui-ci publie de
              lui-meme toutes les N heures. */}
          <button
            type="button"
            onClick={(e) => {
              /* Maj + clic lance un lot tout de suite. Sans quoi, verifier
                 que le minuteur marche demanderait d'attendre six heures. */
              if (e.shiftKey) { void lancerMassPostAuto(); return; }
              onToggleMassPostAuto(currentFolder.id);
            }}
            className="h-8 px-3 rounded-lg flex items-center gap-1.5 text-[13px] font-semibold transition-colors shrink-0"
            style={
              massPostAutoEnabled && massPostAutoFolderId === currentFolder.id
                ? {
                    background: 'rgba(59, 130, 246, 0.12)',
                    border: '1px solid #3b82f6',
                    color: '#93c5fd',
                  }
                : {
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-secondary)',
                  }
            }
            title={`Publier un mass post sur tout ce dossier toutes les ${heuresMassPostAuto} h, sans rien cocher.\nMaj + clic : lancer un lot maintenant.`}
          >
            <Clock size={14} />
            {massPostAutoEnabled && massPostAutoFolderId === currentFolder.id
              ? (() => {
                  const dernier = Number(massPostAutoLastRun || 0);
                  if (!dernier) return `Mass post auto — ${heuresMassPostAuto} h`;
                  const restant = dernier + heuresMassPostAuto * 3600000 - Date.now();
                  if (restant <= 0) return 'Mass post auto — imminent';
                  const h = Math.floor(restant / 3600000);
                  const m = Math.round((restant % 3600000) / 60000);
                  return `Mass post auto — dans ${h ? h + ' h ' : ''}${m} min`;
                })()
              : 'Mass post auto — OFF'}
          </button>
        </form>
      )}

      {/* Subfolder tabs when viewing a parent folder */}
      {currentFolder && (() => {
        const subfolders = folders.filter(f => f.parentId === currentFolder.id);
        if (subfolders.length === 0) return null;
        return (
          <div className="px-5 py-2 flex items-center gap-1.5 overflow-x-auto" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <button
              onClick={() => onSelectFolder(currentFolder.id)}
              className="px-2.5 py-1 rounded-lg text-[12px] font-medium transition-colors whitespace-nowrap"
              style={{
                background: selectedFolderId === currentFolder.id ? 'var(--accent-subtle)' : 'transparent',
                color: selectedFolderId === currentFolder.id ? 'var(--accent-light)' : 'var(--text-muted)',
                border: selectedFolderId === currentFolder.id ? '1px solid var(--accent)' : '1px solid transparent',
              }}
            >
              All
            </button>
            {subfolders.map(sub => (
              <button
                key={sub.id}
                onClick={() => onSelectFolder(sub.id)}
                className="px-2.5 py-1 rounded-lg text-[12px] font-medium transition-colors whitespace-nowrap flex items-center gap-1"
                style={{
                  background: selectedFolderId === sub.id ? 'var(--accent-subtle)' : 'transparent',
                  color: selectedFolderId === sub.id ? 'var(--accent-light)' : 'var(--text-muted)',
                  border: selectedFolderId === sub.id ? '1px solid var(--accent)' : '1px solid transparent',
                }}
              >
                {sub.icon && <span className="text-[12px]">{sub.icon}</span>}
                {sub.name}
                <span className="text-[10px] opacity-70">{profiles.filter(p => p.folderId === sub.id).length}</span>
              </button>
            ))}
          </div>
        );
      })()}

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="px-5 py-2 flex items-center gap-2 overflow-x-auto" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <Tag size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <button
            onClick={() => setFilterTag(null)}
            className="px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors shrink-0"
            style={{
              background: filterTag === null ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
              color: filterTag === null ? 'var(--accent-light)' : 'var(--text-muted)',
              border: '1px solid ' + (filterTag === null ? 'var(--accent)' : 'var(--border-default)'),
            }}
          >
            All
          </button>
          {allTags.map(tag => (
            <button
              key={tag}
              onClick={() => setFilterTag(filterTag === tag ? null : tag)}
              className="px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors shrink-0"
              style={{
                background: filterTag === tag ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                color: filterTag === tag ? 'var(--accent-light)' : 'var(--text-muted)',
                border: '1px solid ' + (filterTag === tag ? 'var(--accent)' : 'var(--border-default)'),
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Loading instances...</div>
          </div>
        ) : filteredProfiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: 'var(--bg-elevated)' }}>
              <Users size={28} style={{ color: 'var(--text-muted)' }} />
            </div>
            <div className="text-center">
              <p className="text-[14px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                {searchTerm ? 'No instances found' : 'No instances yet'}
              </p>
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {searchTerm ? 'Try a different search' : 'Create your first instance to get started'}
              </p>
            </div>
            {!searchTerm && isAdmin && (
              <button
                onClick={onShowCreateModal}
                className="px-4 py-2 rounded-lg flex items-center gap-2 text-[13px] font-medium text-white"
                style={{ background: 'var(--accent)' }}
              >
                <Plus size={16} />
                Create Instance
              </button>
            )}
          </div>
        ) : (
          <table className="profile-table w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                {(isAdmin || isVA) && (
                  <th className="w-10 px-3 py-2.5 text-left">
                    <input
                      type="checkbox"
                      checked={selectedProfiles.length === filteredProfiles.length && filteredProfiles.length > 0}
                      onChange={handleSelectAll}
                      className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0 w-3.5 h-3.5"
                    />
                  </th>
                )}
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider cursor-pointer select-none" style={{ color: 'var(--text-muted)' }} onClick={() => toggleSort('name')}>
                  <span className="flex items-center">Instance <SortIcon col="name" /></span>
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Status</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Account</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Bot</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider hidden xl:table-cell" style={{ color: 'var(--text-muted)' }}>OS</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider hidden lg:table-cell" style={{ color: 'var(--text-muted)' }}>Connection</th>
                {isAdmin && (
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider hidden lg:table-cell" style={{ color: 'var(--text-muted)' }}>Assigned To</th>
                )}
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider hidden xl:table-cell" style={{ color: 'var(--text-muted)' }}>Tags</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider hidden 2xl:table-cell" style={{ color: 'var(--text-muted)' }}>Last URL</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider cursor-pointer select-none hidden xl:table-cell" style={{ color: 'var(--text-muted)' }} onClick={() => toggleSort('lastUsed')}>
                  <span className="flex items-center">Last Used <SortIcon col="lastUsed" /></span>
                </th>
                <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider w-44" style={{ color: 'var(--text-muted)' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredProfiles.map((profile) => {
                const isActive = activeProfiles.includes(profile.id);
                const isSelected = selectedProfiles.includes(profile.id);
                const isTestingProxy = testingProxyProfileIds.has(profile.id);
                const proxyTestResult = proxyTestResults[profile.id];
                const conn = getConnectionInfo(profile);
                const remoteActive = !isActive && isLockedByOther(
                  profile,
                  user?.uid || '',
                  currentDeviceName,
                  currentInstallationId
                );
                const locked = remoteActive;
                const isRunning = isActive || remoteActive;
                const remoteDevice = profile.lockedByDevice || 'another device';

                const isDragTarget = dragOverId === profile.id && dragId !== profile.id;
                const isDragging = dragId === profile.id;

                return (
                  <React.Fragment key={profile.id}>
                    {isDragTarget && (
                      <tr style={{ height: 3, padding: 0 }}>
                        <td colSpan={99} style={{ padding: 0, border: 'none', background: 'linear-gradient(90deg, transparent, #818cf8, transparent)', height: 3, borderRadius: 2 }} />
                      </tr>
                    )}
                  <tr
                    className="group"
                    style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      background: isSelected ? 'var(--accent-subtle, rgba(99,102,241,0.06))' : 'transparent',
                      opacity: isDragging ? 0.25 : 1,
                      transform: isDragging ? 'scale(0.98)' : 'scale(1)',
                      transition: 'opacity 0.2s ease, transform 0.2s ease, background 0.15s ease',
                      position: 'relative',
                      zIndex: (statusMenuId === `table-${profile.id}` || botStatusMenuId === `table-${profile.id}` || openMenuId === profile.id) ? 50 : 'auto',
                    }}
                    onMouseEnter={e => { if (!isSelected && !dragId) e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                    draggable={isAdmin}
                    onDragStart={(e) => {
                      if (!isAdmin) return;
                      e.dataTransfer.setData('profileId', profile.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragId(profile.id);
                      setSortBy('custom');
                      setSortOrder('asc');
                    }}
                    onDragOver={(e) => { if (!isAdmin) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverId(profile.id); }}
                    onDragLeave={(e) => { if (!isAdmin) return; if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null); }}
                    onDrop={(e) => { if (!isAdmin) return; e.preventDefault(); handleDrop(profile.id); }}
                    onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                  >
                    {(isAdmin || isVA) && (
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleSelectProfile(profile.id)}
                          className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0 w-3.5 h-3.5"
                        />
                      </td>
                    )}

                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        {isAdmin && (
                          <div className="cursor-grab active:cursor-grabbing shrink-0 opacity-0 group-hover:opacity-40 hover:!opacity-70 transition-opacity" style={{ color: 'var(--text-muted)', marginRight: -4 }}>
                            <GripVertical size={14} />
                          </div>
                        )}
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-[13px] font-bold shrink-0"
                          style={{ background: isRunning ? 'var(--success-subtle)' : 'var(--bg-overlay)', color: isRunning ? 'var(--success)' : 'var(--text-muted)' }}
                        >
                          {profile.platform && platformInfo[profile.platform]
                            ? platformInfo[profile.platform].icon
                            : profile.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{profile.name}</span>
                            {profile.notes && (
                              <span className="relative group/notes shrink-0">
                                <FileText size={11} style={{ color: 'var(--text-muted)', opacity: 0.6 }} />
                                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 rounded-lg text-[11px] whitespace-pre-wrap max-w-[200px] hidden group-hover/notes:block z-50 shadow-lg"
                                  style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>
                                  {profile.notes}
                                </span>
                              </span>
                            )}
                          </div>
                          {profile.platform && platformInfo[profile.platform] && (
                            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{platformInfo[profile.platform].label}</div>
                          )}
                          {/* Deux pastilles : le branding est un etat durable
                              (le compte est habille ou non), la publication un
                              evenement date (le dernier post parti). */}
                          {(() => {
                            const trace = resultatsActions[profile.id] || {};
                            if (!trace.branding && !trace.post && !trace.ecartee &&
                                !(profile as any).lastOpenPost) return null;
                            const chip = (
                              cle: string,
                              nom: string,
                              action?: { statut: string; quand: string; message: string; apercu?: string | null }
                            ) => {
                              if (!action) return null;
                              const ok = action.statut === 'reussi';
                              const quand = new Date(action.quand);
                              const date = isNaN(quand.getTime())
                                ? ''
                                : quand.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) +
                                  ' ' + quand.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
                              return (
                                <span
                                  key={cle}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                                  style={{
                                    background: ok ? 'var(--success-subtle, rgba(34,197,94,0.12))' : 'rgba(248,113,113,0.12)',
                                    color: ok ? 'var(--success, #22c55e)' : '#f87171',
                                  }}
                                  title={`${nom} — ${date}\n${action.message || ''}` +
                                    (action.apercu ? `\n« ${action.apercu} »` : '')}
                                >
                                  {ok ? <CheckCircle2 size={9} /> : <AlertTriangle size={9} />}
                                  {nom}
                                </span>
                              );
                            };
                            // Le dernier tour Open Post : retweet et like,
                            // avec la panne au survol quand il en manque un.
                            const tour = (profile as any).lastOpenPost;
                            const chipTour = (cle: string, nom: string, fait: boolean) => (
                              <span
                                key={cle}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                                style={{
                                  background: fait ? 'var(--success-subtle, rgba(34,197,94,0.12))' : 'rgba(248,113,113,0.12)',
                                  color: fait ? 'var(--success, #22c55e)' : '#f87171',
                                }}
                                title={`${nom} — ${new Date(tour.quand).toLocaleString('fr-FR')}` +
                                  (fait ? '' : `\n${tour.panne || 'non confirmé'}`)}
                              >
                                {fait ? <CheckCircle2 size={9} /> : <AlertTriangle size={9} />}
                                {nom}
                              </span>
                            );
                            return (
                              <div className="flex items-center gap-1 mt-1 flex-wrap">
                                {tour && chipTour('rt', 'RT', Boolean(tour.retweet))}
                                {tour && chipTour('like', 'Like', Boolean(tour.like))}
                                {trace.ecartee && (
                                  <span
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                                    style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}
                                    title={`Mise de côté — ${trace.ecartee.raison || ''}`}
                                  >
                                    <Square size={9} /> Écartée
                                  </span>
                                )}
                                {chip('branding', 'Branding', trace.branding)}
                                {chip('post', 'Post', trace.post)}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-2.5">
                      {isActive ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium" style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}>
                          <Circle size={6} className="fill-current status-dot-active" />
                          Running locally
                        </span>
                      ) : remoteActive ? (
                        <span
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium"
                          style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}
                          title={`Running for ${profile.lockedByEmail || '?'} on ${remoteDevice}`}
                        >
                          <Monitor size={10} />
                          Running on {remoteDevice}
                        </span>
                      ) : (
                        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Idle</span>
                      )}
                    </td>

                    <td className="px-3 py-2.5">
                      {(() => {
                        const s = statusOptions.find(o => o.id === (profile.status || 'none'));
                        return (
                          <div className="relative">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isAdmin) setStatusMenuId(statusMenuId === `table-${profile.id}` ? null : `table-${profile.id}`);
                              }}
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all ${isAdmin ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
                              style={{ background: s ? s.bg : 'var(--bg-elevated)', color: s ? s.color : 'var(--text-muted)', border: `1px solid ${s ? s.color + '33' : 'var(--border-default)'}` }}
                            >
                              <span className="w-1.5 h-1.5 rounded-full" style={{ background: s ? s.color : 'var(--text-muted)' }} />
                              {s ? s.label : 'No Status'}
                              {isAdmin && <ChevronDown size={10} style={{ opacity: 0.6 }} />}
                            </button>
                            {isAdmin && statusMenuId === `table-${profile.id}` && (
                              <div
                                className="absolute top-full left-0 mt-1 rounded-lg shadow-xl py-1 min-w-[150px]"
                                style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)', zIndex: 9999 }}
                                onClick={e => e.stopPropagation()}
                              >
                                {statusOptions.map(opt => (
                                  <button
                                    key={opt.id}
                                    onClick={() => {
                                      onUpdateProfile(profile.id, { status: opt.id });
                                      setStatusMenuId(null);
                                    }}
                                    className="w-full px-3 py-1.5 text-[12px] text-left flex items-center gap-2 transition-colors"
                                    style={{ color: (profile.status || 'none') === opt.id ? opt.color : 'var(--text-secondary)' }}
                                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                  >
                                    <span className="w-2 h-2 rounded-full" style={{ background: opt.color }} />
                                    {opt.label}
                                    {(profile.status || 'none') === opt.id && <span className="ml-auto text-[10px]">✓</span>}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>

                    <td className="px-3 py-2.5">
                      {(() => {
                        const b = botStatusOptions.find(o => o.id === (profile.botStatus || 'none'));
                        return (
                          <div className="relative">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isAdmin) setBotStatusMenuId(botStatusMenuId === `table-${profile.id}` ? null : `table-${profile.id}`);
                              }}
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all ${isAdmin ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
                              style={{ background: b ? b.bg : 'var(--bg-elevated)', color: b ? b.color : 'var(--text-muted)', border: `1px solid ${b ? b.color + '33' : 'var(--border-default)'}` }}
                            >
                              <span className="w-1.5 h-1.5 rounded-full" style={{ background: b ? b.color : 'var(--text-muted)' }} />
                              {b ? b.label : 'No Status'}
                              {isAdmin && <ChevronDown size={10} style={{ opacity: 0.6 }} />}
                            </button>
                            {isAdmin && botStatusMenuId === `table-${profile.id}` && (
                              <div
                                className="absolute top-full left-0 mt-1 rounded-lg shadow-xl py-1 min-w-[160px]"
                                style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)', zIndex: 9999 }}
                                onClick={e => e.stopPropagation()}
                              >
                                {botStatusOptions.map(opt => (
                                  <button
                                    key={opt.id}
                                    onClick={() => {
                                      onUpdateProfile(profile.id, { botStatus: opt.id });
                                      setBotStatusMenuId(null);
                                    }}
                                    className="w-full px-3 py-1.5 text-[12px] text-left flex items-center gap-2 transition-colors"
                                    style={{ color: (profile.botStatus || 'none') === opt.id ? opt.color : 'var(--text-secondary)' }}
                                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                  >
                                    <span className="w-2 h-2 rounded-full" style={{ background: opt.color }} />
                                    {opt.label}
                                    {(profile.botStatus || 'none') === opt.id && <span className="ml-auto text-[10px]">✓</span>}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>

                    <td className="px-3 py-2.5 hidden xl:table-cell">
                      <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                        <Monitor size={13} style={{ opacity: 0.6 }} />
                        <span>{getOSLabel(profile.os)}</span>
                      </div>
                    </td>

                    <td className="px-3 py-2.5 hidden lg:table-cell">
                      <div className="flex items-center gap-1.5 text-[12px]" style={{ color: conn.color }}>
                        {conn.icon}
                        <span className="truncate max-w-[100px]">{conn.label}</span>
                      </div>
                    </td>

                    {isAdmin && (
                      <td className="px-3 py-2.5 hidden lg:table-cell">
                        {profile.assignedToEmail ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-light)' }}>
                            <UserPlus size={10} />
                            {profile.assignedToEmail.split('@')[0]}
                          </span>
                        ) : (
                          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>-</span>
                        )}
                      </td>
                    )}

                    <td className="px-3 py-2.5 hidden xl:table-cell">
                      <div className="flex gap-1 flex-wrap">
                        {(profile.tags || []).slice(0, 2).map(tag => (
                          <span key={tag} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-light)' }}>
                            {tag}
                          </span>
                        ))}
                        {(profile.tags || []).length > 2 && (
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>+{(profile.tags || []).length - 2}</span>
                        )}
                      </div>
                    </td>

                    <td className="px-3 py-2.5 hidden 2xl:table-cell">
                      {profile.lastUrl ? (
                        <div className="flex items-center gap-1.5 text-[12px] max-w-[150px]" style={{ color: 'var(--text-secondary)' }}>
                          <ExternalLink size={12} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
                          <span className="truncate">{truncateUrl(profile.lastUrl)}</span>
                        </div>
                      ) : (
                        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </td>

                    <td className="px-3 py-2.5 hidden xl:table-cell">
                      <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{formatDate(profile.lastUsed)}</span>
                    </td>

                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {profile.proxy?.host && (
                          <>
                            {proxyTestResult && !isTestingProxy && (
                              <span
                                className="px-1.5 py-1 rounded-md text-[10px] font-mono tabular-nums whitespace-nowrap"
                                style={{
                                  color: proxyTestResult.isHealthy ? 'var(--success)' : 'var(--danger)',
                                  background: proxyTestResult.isHealthy
                                    ? 'var(--success-subtle)'
                                    : 'var(--danger-subtle)',
                                }}
                                title={`Pays ${proxyTestResult.country} · Ping ${proxyTestResult.ping} ms`}
                              >
                                {proxyTestResult.country} · {proxyTestResult.ping} ms
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => handleTestProfileProxy(profile)}
                              disabled={isTestingProxy}
                              className="p-1.5 rounded-md transition-colors disabled:opacity-60"
                              style={{
                                color: 'var(--accent-light)',
                                background: 'var(--accent-subtle)',
                              }}
                              title="Tester le proxy de cette instance"
                            >
                              {isTestingProxy
                                ? <Loader2 size={13} className="animate-spin" />
                                : <Shield size={13} />}
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => !locked && onLaunchProfile(profile)}
                          className="px-3 py-1.5 rounded-md flex items-center gap-1.5 text-[12px] font-medium transition-all"
                          style={{
                            background: locked ? 'var(--bg-elevated)' : isActive ? 'var(--success)' : 'var(--accent)',
                            boxShadow: locked ? 'none' : isActive ? '0 1px 4px rgba(34,197,94,0.3)' : '0 1px 4px rgba(99,102,241,0.3)',
                            color: locked ? 'var(--text-muted)' : 'white',
                            cursor: locked ? 'not-allowed' : 'pointer',
                          }}
                          title={locked ? `Utilis\u00e9 par ${profile.lockedByEmail || '?'} sur ${profile.lockedByDevice || '?'}` : ''}
                        >
                          {isActive ? (
                            <><Circle size={10} className="fill-current status-dot-active" /> Active</>
                          ) : remoteActive ? (
                            <><Monitor size={12} /> On {remoteDevice}</>
                          ) : (
                            <><Play size={12} /> Open</>
                          )}
                        </button>

                        {isAdmin && (
                        <div className="relative">
                          <button
                            onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === profile.id ? null : profile.id); }}
                            className="p-1.5 rounded-md transition-colors opacity-0 group-hover:opacity-100"
                            style={{ color: 'var(--text-muted)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-overlay)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          >
                            <MoreVertical size={14} />
                          </button>

                          {openMenuId === profile.id && (
                            <div
                              className="absolute right-0 top-full mt-1 rounded-lg shadow-xl z-20 py-1 min-w-[170px]"
                              style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)' }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {isAdmin && (
                                <button
                                  onClick={() => { onEditProfile(profile); setOpenMenuId(null); }}
                                  className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <Edit size={13} /> Edit
                                </button>
                              )}

                              {isAdmin && (
                                <button
                                  onClick={() => { onCloneProfile(profile); setOpenMenuId(null); }}
                                  className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <Copy size={13} /> Clone
                                </button>
                              )}

                              {isAdmin && (
                                <button
                                  onClick={() => { setAssignProfileId(profile.id); setOpenMenuId(null); }}
                                  className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <UserPlus size={13} /> Assign
                                </button>
                              )}

                              {isAdmin && (
                                <button
                                  onClick={() => {
                                    openMoveModal([profile.id]);
                                    setOpenMenuId(null);
                                  }}
                                  className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <MoveRight size={13} /> Move
                                </button>
                              )}

                              {/* Set Status submenu */}
                              <div className="relative">
                                <button
                                  onClick={(e) => { e.stopPropagation(); setStatusMenuId(statusMenuId === profile.id ? null : profile.id); }}
                                  className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 justify-between transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <span className="flex items-center gap-2"><Circle size={13} /> Set Status</span>
                                  <ChevronRight size={12} />
                                </button>
                                {statusMenuId === profile.id && (
                                  <div
                                    className="absolute left-full top-0 ml-1 rounded-lg shadow-xl z-30 py-1 min-w-[140px]"
                                    style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)' }}
                                    onClick={e => e.stopPropagation()}
                                  >
                                    {statusOptions.map(s => (
                                      <button
                                        key={s.id}
                                        onClick={() => {
                                          onUpdateProfile(profile.id, { status: s.id });
                                          setOpenMenuId(null);
                                          setStatusMenuId(null);
                                        }}
                                        className="w-full px-3 py-1.5 text-[12px] text-left flex items-center gap-2 transition-colors"
                                        style={{ color: profile.status === s.id ? s.color : 'var(--text-secondary)' }}
                                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                      >
                                        <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                                        {s.label}
                                        {profile.status === s.id && <span className="ml-auto text-[10px]">✓</span>}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>

                              {/* Set Bot Status submenu */}
                              <div className="relative">
                                <button
                                  onClick={(e) => { e.stopPropagation(); setBotStatusMenuId(botStatusMenuId === profile.id ? null : profile.id); }}
                                  className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 justify-between transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <span className="flex items-center gap-2"><Bot size={13} /> Set Bot Status</span>
                                  <ChevronRight size={12} />
                                </button>
                                {botStatusMenuId === profile.id && (
                                  <div
                                    className="absolute left-full top-0 ml-1 rounded-lg shadow-xl z-30 py-1 min-w-[160px]"
                                    style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)' }}
                                    onClick={e => e.stopPropagation()}
                                  >
                                    {botStatusOptions.map(s => (
                                      <button
                                        key={s.id}
                                        onClick={() => {
                                          onUpdateProfile(profile.id, { botStatus: s.id });
                                          setOpenMenuId(null);
                                          setBotStatusMenuId(null);
                                        }}
                                        className="w-full px-3 py-1.5 text-[12px] text-left flex items-center gap-2 transition-colors"
                                        style={{ color: profile.botStatus === s.id ? s.color : 'var(--text-secondary)' }}
                                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                      >
                                        <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                                        {s.label}
                                        {profile.botStatus === s.id && <span className="ml-auto text-[10px]">✓</span>}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>

                              <button
                                onClick={() => handleImportCookies(profile)}
                                className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                style={{ color: 'var(--text-secondary)' }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                              >
                                <Upload size={13} /> Import Cookies
                              </button>

                              <button
                                onClick={() => handleExportCookies(profile)}
                                className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                style={{ color: 'var(--text-secondary)' }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                              >
                                <Download size={13} /> Export Cookies
                              </button>

                              <button
                                onClick={() => setOpenMenuId(null)}
                                className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                style={{ color: 'var(--text-secondary)' }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                              >
                                <Settings size={13} /> Settings
                              </button>

                              {isAdmin && (
                                <>
                                  <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '2px 0' }} />
                                  <button
                                    onClick={() => {
                                      definirModeleBot(profile);
                                      setOpenMenuId(null);
                                    }}
                                    className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                    style={{ color: profile.botTemplate ? 'var(--success)' : 'var(--text-secondary)' }}
                                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                    title="Ses réglages de robot serviront aux autres instances du dossier"
                                  >
                                    <ShieldCheck size={13} />
                                    {profile.botTemplate ? 'Modèle du robot ✓' : 'Utiliser comme modèle'}
                                  </button>
                                  <button
                                    onClick={async () => {
                                      setOpenMenuId(null);
                                      if (!profile.folderId) {
                                        showToast('Range d’abord cette instance dans un dossier', 'warning');
                                        return;
                                      }
                                      try {
                                        await (window as any).electronAPI?.branding?.openFolder(profile.folderId);
                                      } catch {
                                        showToast('Dossier de branding introuvable', 'error');
                                      }
                                    }}
                                    className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                    style={{ color: 'var(--text-secondary)' }}
                                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                    title="Photos, bannières, bios, noms et lieux du dossier"
                                  >
                                    <FolderOpen size={13} /> Dossier de branding
                                  </button>
                                  {/* Une instance que X refuse revient en echec a chaque
                                      tour : la mettre de cote la sort des lots sans la
                                      supprimer. */}
                                  <button
                                    onClick={() => {
                                      setOpenMenuId(null);
                                      basculerEcartee(profile);
                                    }}
                                    className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                    style={{
                                      color: resultatsActions[profile.id]?.ecartee
                                        ? 'var(--warning, #fbbf24)'
                                        : 'var(--text-secondary)',
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                    title="Le branding et le mass post sauteront cette instance"
                                  >
                                    <Square size={13} />
                                    {resultatsActions[profile.id]?.ecartee
                                      ? 'Remettre dans les lots'
                                      : 'Ne plus lancer'}
                                  </button>
                                  <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '2px 0' }} />
                                  <button
                                    onClick={() => {
                                      if (window.confirm(`Delete "${profile.name}"?`)) {
                                        onDeleteProfile(profile.id);
                                        setOpenMenuId(null);
                                      }
                                    }}
                                    className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                    style={{ color: 'var(--danger)' }}
                                    onMouseEnter={e => e.currentTarget.style.background = 'var(--danger-subtle)'}
                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                  >
                                    <Trash2 size={13} /> Delete
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                        )}
                      </div>
                    </td>
                  </tr>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showMoveModal && (
        <MoveFolderModal
          isOpen={showMoveModal}
          onClose={() => setShowMoveModal(false)}
          folders={folders}
          selectedCount={moveProfileIds.length}
          onMove={handleMoveProfiles}
        />
      )}

      {assignProfile && (
        <AssignProfileModal
          profileName={assignProfile.name}
          currentAssignee={assignProfile.assignedTo}
          onClose={() => setAssignProfileId(null)}
          onAssign={(userId, userEmail) => handleAssign(assignProfile.id, userId, userEmail)}
        />
      )}

      {bulkAssignMode && (
        <AssignProfileModal
          profileName={`${selectedProfiles.length} instances`}
          onClose={() => setBulkAssignMode(false)}
          onAssign={(userId, userEmail) => handleBulkAssign(userId, userEmail)}
        />
      )}

      {panneauBranding && lotBranding && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-5"
          style={{ background: 'rgba(0,0,0,0.72)' }}
          onMouseDown={e => { if (e.target === e.currentTarget) setPanneauBranding(null); }}
        >
          <div
            className="w-full max-w-2xl rounded-2xl p-5 max-h-[86vh] overflow-auto"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                Branding — toutes les instances
              </div>
              <button onClick={() => setPanneauBranding(null)} style={{ color: 'var(--text-muted)' }}>
                <XIcon size={18} />
              </button>
            </div>
            <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
              Un seul lot pour tout ton parc : tu le remplis une fois. Chaque compte reçoit une photo,
              une bannière, un nom, une bio et un lieu tirés d’ici — et jamais les mêmes qu’un autre
              compte. Une ligne = une valeur possible.
            </p>

            <div className="grid grid-cols-2 gap-3 mb-4">
              {([
                ['photos', 'Photos de profil', lotBranding.photos],
                ['bannieres', 'Bannières', lotBranding.bannieres],
              ] as const).map(([sorte, titre, nombre]) => (
                <div key={sorte} className="rounded-xl p-3" style={{ background: 'var(--bg-elevated)' }}>
                  <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{titre}</div>
                  <div className="text-2xl font-semibold my-1" style={{ color: nombre > 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {nombre}
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => ajouterImagesBranding(sorte)}
                      className="px-2 py-1 rounded text-[11px] font-semibold text-white"
                      style={{ background: 'var(--accent)' }}
                    >
                      Ajouter
                    </button>
                    <button
                      onClick={async () => {
                        if (!window.confirm(`Retirer les ${nombre} image(s) ?`)) return;
                        const r = await (window as any).electronAPI?.branding?.clearImages(panneauBranding, sorte);
                        if (r?.etat) setLotBranding(r.etat);
                      }}
                      className="px-2 py-1 rounded text-[11px]"
                      style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)' }}
                    >
                      Vider
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {([
              ['noms', 'Noms affichés', 'Madison\nMadi\nMads'],
              ['bios', 'Bios', 'une bio par ligne'],
              ['liens', 'Liens', 'https://…'],
              ['lieux', 'Lieux', 'US | Miami, FL\nUS | Austin, TX\nGB | London'],
            ] as const).map(([cle, titre, exemple]) => (
              <div key={cle} className="mb-3">
                <label className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {titre}
                  <span className="font-normal ml-2" style={{ color: 'var(--text-muted)' }}>
                    {String(lotBranding[cle] || '').split('\n').filter(l => l.trim()).length} valeur(s)
                  </span>
                </label>
                <textarea
                  value={lotBranding[cle] || ''}
                  onChange={e => setLotBranding({ ...lotBranding, [cle]: e.target.value })}
                  rows={cle === 'bios' ? 4 : 3}
                  placeholder={exemple}
                  className="w-full mt-1 px-3 py-2 rounded-lg text-[13px] outline-none"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                    resize: 'vertical',
                  }}
                />
                {cle === 'lieux' && (
                  <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                    Le pays devant est facultatif. S’il y est, le lieu n’ira qu’aux comptes sortant par ce pays —
                    Miami derrière un proxy allemand, c’est la contradiction qui se repère.
                  </div>
                )}
              </div>
            ))}

            <div className="flex items-center justify-between gap-3 mt-5">
              <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                Fenêtres en même temps
                <select
                  value={parallelesBranding}
                  onChange={e => setParallelesBranding(Number(e.target.value))}
                  className="px-2 py-1.5 rounded-lg text-xs outline-none"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {[1, 2, 3, 4, 6, 8, 10, 12].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2">
              <button
                onClick={enregistrerTextesBranding}
                className="px-4 py-2 rounded-lg text-xs font-semibold"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
              >
                Enregistrer
              </button>
              <button
                onClick={async () => {
                  await enregistrerTextesBranding();
                  setPanneauBranding(null);
                  lancerBranding();
                }}
                disabled={selectedProfiles.length === 0}
                className="px-4 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
                style={{ background: '#22c55e' }}
              >
                Brander la sélection ({selectedProfiles.length})
              </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {panneauPublication && lotBranding && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-5"
          style={{ background: 'rgba(0,0,0,0.72)' }}
          onMouseDown={e => { if (e.target === e.currentTarget) setPanneauPublication(null); }}
        >
          <div
            className="w-full max-w-2xl rounded-2xl p-5 max-h-[86vh] overflow-auto"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                Mass post — un post par instance
              </div>
              <button onClick={() => setPanneauPublication(null)} style={{ color: 'var(--text-muted)' }}>
                <XIcon size={18} />
              </button>
            </div>
            <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
              Chaque instance sélectionnée publie <strong>un</strong> post, tiré au hasard ici.
              Deux comptes ne reçoivent jamais le même texte, et un compte ne republie pas ce qu’il a
              déjà envoyé. Une ligne = un post — sauf si tu sépares tes posts par une ligne
              contenant <strong>---</strong>, ce qu’il faut faire dès qu’un post tient sur
              plusieurs lignes.
            </p>

            <div className="rounded-xl p-3 mb-4" style={{ background: 'var(--bg-elevated)' }}>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                Médias à joindre
              </div>
              <div
                className="text-2xl font-semibold my-1"
                style={{ color: lotBranding.medias > 0 ? 'var(--success)' : 'var(--text-muted)' }}
              >
                {lotBranding.medias}
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={() => ajouterImagesBranding('medias')}
                  className="px-2 py-1 rounded text-[11px] font-semibold text-white"
                  style={{ background: 'var(--accent)' }}
                >
                  Ajouter
                </button>
                <button
                  onClick={async () => {
                    if (!window.confirm(`Retirer les ${lotBranding.medias} média(s) ?`)) return;
                    const r = await (window as any).electronAPI?.branding
                      ?.clearImages(panneauPublication, 'medias');
                    if (r?.etat) setLotBranding(r.etat);
                  }}
                  className="px-2 py-1 rounded text-[11px]"
                  style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)' }}
                >
                  Vider
                </button>
              </div>
              <div className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
                Images et vidéos, 40 Mo au maximum par fichier. Sans média, les posts partent en
                texte seul.
              </div>
            </div>

            <div className="mb-3">
              <label className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                Posts
                <span className="font-normal ml-2" style={{ color: 'var(--text-muted)' }}>
                  {compterPosts(String(lotBranding.posts || ''))} post(s)
                </span>
              </label>
              <textarea
                value={lotBranding.posts || ''}
                onChange={e => setLotBranding({ ...lotBranding, posts: e.target.value })}
                rows={10}
                placeholder={'un post court\n---\nun post qui tient\nsur plusieurs lignes\n---\nencore un autre'}
                className="w-full mt-1 px-3 py-2 rounded-lg text-[13px] outline-none"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                  resize: 'vertical',
                }}
              />
              {/* Le compte des posts face au nombre d'instances : en dessous, des
                  comptes republieront ce qu'ils ont deja envoye. */}
              {compterPosts(String(lotBranding.posts || ''))
                < selectedProfiles.length && selectedProfiles.length > 0 && (
                <div className="text-[10px] mt-1" style={{ color: 'var(--warning, #fbbf24)' }}>
                  Moins de posts que d’instances sélectionnées : certains comptes recevront un texte
                  déjà utilisé ailleurs.
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 mt-5">
              <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                Fenêtres en même temps
                <select
                  value={parallelesPost}
                  onChange={e => setParallelesPost(Number(e.target.value))}
                  className="px-2 py-1.5 rounded-lg text-xs outline-none"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {[1, 2, 3, 4, 6, 8, 10, 12].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2">
                <button
                  onClick={enregistrerTextesBranding}
                  className="px-4 py-2 rounded-lg text-xs font-semibold"
                  style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
                >
                  Enregistrer
                </button>
                <button
                  onClick={async () => {
                    await enregistrerTextesBranding();
                    setPanneauPublication(null);
                    lancerPublication();
                  }}
                  disabled={selectedProfiles.length === 0}
                  className="px-4 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
                  style={{ background: '#38bdf8' }}
                >
                  Publier depuis la sélection ({selectedProfiles.length})
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
