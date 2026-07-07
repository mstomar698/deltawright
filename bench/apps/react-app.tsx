// A realistic React SPA for the benchmark: an inventory dashboard with a data
// table, an optional live-updating "noise" ticker (real React re-render churn on
// surviving cells), and a modal-open action whose delta we measure. Config comes
// from window.__benchConfig set by the harness before this bundle runs.
import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

interface BenchConfig {
  rows: number;
  noise: boolean;
  intervalMs: number;
}

const cfg: BenchConfig = (window as unknown as { __benchConfig?: BenchConfig }).__benchConfig ?? {
  rows: 50,
  noise: false,
  intervalMs: 60,
};

const STATUSES = ['active', 'idle', 'error', 'pending'];

interface RowData {
  id: number;
  name: string;
  status: string;
}

function makeRows(n: number): RowData[] {
  const rows: RowData[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({ id: i, name: `Item ${i}`, status: STATUSES[i % STATUSES.length]! });
  }
  return rows;
}

function App() {
  const [rows] = useState(() => makeRows(cfg.rows));
  const [tick, setTick] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);

  // The "noise": a real live-data ticker that re-renders the Live column of
  // every row on each tick, producing genuine React reconciliation churn on
  // surviving elements — exactly the SPA background activity that a
  // time-window-scoped delta would sweep up alongside the real action.
  useEffect(() => {
    if (!cfg.noise) return;
    const id = setInterval(() => setTick((t) => t + 1), cfg.intervalMs);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="app">
      <header>
        <h1>Inventory</h1>
      </header>
      <div className="toolbar">
        <button id="open-modal" onClick={() => setModalOpen(true)}>
          New item
        </button>
        <span className="ticks">updates: {tick}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Status</th>
            <th>Live</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.name}</td>
              <td className={`status status-${r.status}`}>{r.status}</td>
              <td className="live">{cfg.noise ? (tick * 7 + r.id) % 1000 : '-'}</td>
              <td>
                <button className="row-act">Edit</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {modalOpen && (
        <div
          className="modal"
          role="dialog"
          aria-label="New item"
          style={{
            position: 'fixed',
            left: 400,
            top: 200,
            width: 360,
            padding: 20,
            background: '#fff',
            border: '1px solid #333',
            boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
          }}
        >
          <p>Create a new inventory item.</p>
          <label>
            Name <input className="modal-name" aria-label="Name" />
          </label>
          <div className="modal-actions">
            <button className="save">Save</button>
            <button className="cancel" onClick={() => setModalOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
