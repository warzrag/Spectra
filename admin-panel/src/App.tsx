import React, { useState, useEffect } from 'react';
import { LayoutDashboard, Users, Activity, LogOut, Shield, Loader2 } from 'lucide-react';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import UsersPage from './pages/UsersPage';
import ActivityPage from './pages/ActivityPage';
import { onAuthStateChanged, logout, AppUser } from './services/auth-service';

type Page = 'dashboard' | 'users' | 'activity';

const App: React.FC = () => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activePage, setActivePage] = useState<Page>('dashboard');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged((u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return unsubscribe;
  }, []);

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setActivePage('dashboard');
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <Loader2 size={28} className="animate-spin text-indigo-500 mx-auto mb-3" />
          <p className="text-gray-500 text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  const navItems: { page: Page; label: string; icon: React.ReactNode }[] = [
    { page: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={18} /> },
    { page: 'users', label: 'Users', icon: <Users size={18} /> },
    { page: 'activity', label: 'Activity', icon: <Activity size={18} /> },
  ];

  const renderPage = () => {
    switch (activePage) {
      case 'dashboard': return <DashboardPage />;
      case 'users': return <UsersPage />;
      case 'activity': return <ActivityPage />;
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col">
        {/* Logo */}
        <div className="px-4 py-5 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
              <Shield size={16} className="text-white" />
            </div>
            <div>
              <div className="text-sm font-bold text-white">Spectra</div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">Admin Panel</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map(({ page, label, icon }) => (
            <button
              key={page}
              onClick={() => setActivePage(page)}
              className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2.5 text-sm font-medium transition-colors ${
                activePage === page
                  ? 'bg-indigo-500/10 text-indigo-400'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}
            >
              {icon}
              {label}
            </button>
          ))}
        </nav>

        {/* User + Logout */}
        <div className="px-3 py-4 border-t border-gray-800 space-y-3">
          <div className="flex items-center gap-2 px-2">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-[10px] font-bold text-white">
              {user.email.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-white truncate">{user.email}</div>
              <div className="text-[10px] text-indigo-400 uppercase font-semibold">admin</div>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-red-400 hover:bg-red-500/10 flex items-center gap-2 transition-colors"
          >
            <LogOut size={14} />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-6 overflow-auto">
        {renderPage()}
      </main>
    </div>
  );
};

export default App;
