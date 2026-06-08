// Layout component - sidebar + main content
import { ReactNode, useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { LayoutDashboard, MessageSquare, BarChart3, LogOut, Plus } from 'lucide-react';
import { getPortfolios, type Portfolio } from '@/services/db';

export function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);

  useEffect(() => {
    getPortfolios().then(setPortfolios).catch(console.error);
  }, []);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate('/login');
  };

  const navItems = [
    { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { path: '/ai', icon: MessageSquare, label: 'AI Chat' },
    { path: '/comparison', icon: BarChart3, label: 'Comparison' },
  ];

  return (
    <div className="flex h-screen bg-slate-50">
      {/* Sidebar */}
      <aside className="w-64 border-r border-slate-200 bg-white">
        <div className="flex h-16 items-center border-b border-slate-200 px-6">
          <h1 className="text-xl font-bold text-slate-900">📊 PaperTrade</h1>
        </div>

        <nav className="p-4">
          <div className="mb-4">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`mb-1 flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-primary-50 text-primary-700'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>

          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between px-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Portfolios
              </h2>
              <Link
                to="/?action=create"
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                title="New portfolio"
              >
                <Plus className="h-3.5 w-3.5" />
              </Link>
            </div>
            <div className="space-y-1">
              {portfolios.length === 0 ? (
                <div className="px-3 py-2 text-xs text-slate-400">
                  No portfolios yet
                </div>
              ) : (
                portfolios.map((p) => {
                  const isActive = location.pathname === `/portfolio/${p.id}`;
                  return (
                    <Link
                      key={p.id}
                      to={`/portfolio/${p.id}`}
                      className={`block truncate rounded-md px-3 py-2 text-sm transition-colors ${
                        isActive
                          ? 'bg-primary-50 text-primary-700'
                          : 'text-slate-600 hover:bg-slate-100'
                      }`}
                      title={p.name}
                    >
                      {p.name}
                    </Link>
                  );
                })
              )}
            </div>
          </div>
        </nav>

        <div className="absolute bottom-0 w-64 border-t border-slate-200 p-4">
          <button
            onClick={handleSignOut}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}