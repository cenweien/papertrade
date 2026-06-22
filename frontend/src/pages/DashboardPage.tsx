// DashboardPage - Overview of all portfolios
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Trash2, Copy, RotateCcw } from 'lucide-react';
import {
  ensureDefaultPortfolio,
  createPortfolio,
  archivePortfolio,
  clonePortfolio,
  resetPortfolio,
  getPositions,
  type Portfolio,
} from '@/services/db';

export function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [positionsByPortfolio, setPositionsByPortfolio] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  // Form state
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newCapital, setNewCapital] = useState('100000000');
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await ensureDefaultPortfolio();
      setPortfolios(data);

      // Get position count for each portfolio
      const counts: Record<string, number> = {};
      await Promise.all(
        data.map(async (p) => {
          const positions = await getPositions(p.id);
          counts[p.id] = positions.length;
        })
      );
      setPositionsByPortfolio(counts);
    } catch (err) {
      console.error('Failed to load portfolios:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    if (searchParams.get('action') === 'create') {
      setShowCreate(true);
    }
  }, [searchParams]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await createPortfolio({
        name: newName.trim(),
        description: newDescription.trim() || undefined,
        initial_capital: parseFloat(newCapital) || 100000000,
      });
      setNewName('');
      setNewDescription('');
      setNewCapital('100000000');
      setShowCreate(false);
      setSearchParams({});
      await load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleArchive = async (id: string, name: string) => {
    if (!confirm(`Archive "${name}"? You can restore it later.`)) return;
    await archivePortfolio(id);
    await load();
  };

  const handleClone = async (id: string) => {
    await clonePortfolio(id);
    await load();
  };

  const handleReset = async (id: string, name: string) => {
    if (!confirm(`Reset "${name}"? This will delete all positions and trades.`)) return;
    await resetPortfolio(id);
    await load();
  };

  if (loading) {
    return <div className="p-8 text-slate-600">Loading portfolios...</div>;
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Dashboard</h1>
          <p className="mt-1 text-slate-600">
            {portfolios.length} {portfolios.length === 1 ? 'portfolio' : 'portfolios'}
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary flex items-center gap-2"
        >
          <Plus className="h-4 w-4" />
          New Portfolio
        </button>
      </div>

      {showCreate && (
        <div className="card mb-6">
          <h2 className="mb-4 text-lg font-semibold">Create new portfolio</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="label">Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Aggressive Growth"
                className="input mt-1"
                required
                disabled={creating}
              />
            </div>
            <div>
              <label className="label">Description (optional)</label>
              <input
                type="text"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Brief strategy description"
                className="input mt-1"
                disabled={creating}
              />
            </div>
            <div>
              <label className="label">Initial Capital ($)</label>
              <input
                type="number"
                value={newCapital}
                onChange={(e) => setNewCapital(e.target.value)}
                min="1"
                className="input mt-1"
                required
                disabled={creating}
              />
            </div>
            <div className="flex gap-2">
              <button type="submit" disabled={creating} className="btn-primary">
                {creating ? 'Creating...' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCreate(false);
                  setSearchParams({});
                }}
                disabled={creating}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {portfolios.length === 0 ? (
        <div className="card text-center">
          <p className="text-slate-600">
            No portfolios yet. Create one to get started!
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {portfolios.map((p) => (
            <div key={p.id} className="card">
              <Link to={`/portfolio/${p.id}`} className="block">
                <h3 className="text-lg font-semibold text-slate-900 hover:text-primary-600">
                  {p.name}
                </h3>
                {p.description && (
                  <p className="mt-1 text-sm text-slate-500">{p.description}</p>
                )}
                <div className="mt-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Initial Capital</span>
                    <span className="font-medium text-slate-900">
                      ${p.initial_capital.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Cash Available</span>
                    <span className="font-medium text-slate-900">
                      ${p.current_capital.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Positions</span>
                    <span className="font-medium text-slate-900">
                      {positionsByPortfolio[p.id] || 0}
                    </span>
                  </div>
                </div>
              </Link>
              <div className="mt-4 flex gap-1 border-t border-slate-200 pt-3">
                <button
                  onClick={() => handleClone(p.id)}
                  className="btn-ghost flex-1 text-xs"
                  title="Clone"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => handleReset(p.id, p.name)}
                  className="btn-ghost flex-1 text-xs"
                  title="Reset"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => handleArchive(p.id, p.name)}
                  className="btn-ghost flex-1 text-xs text-red-600 hover:bg-red-50"
                  title="Archive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}