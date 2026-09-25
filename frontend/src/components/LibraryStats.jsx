import { Layers, CheckCircle, Sparkles } from 'lucide-react';

export function LibraryStats({ totalCount, staticCount, animatedCount }) {
  return (
    <>
      {/* Statistics Row */}
      <section className="stats-grid">
        <div className="stat-card glass-panel glass-panel-interactive">
          <div>
            <div className="stat-label">Total Grabbed</div>
            <div className="stat-value">{totalCount}</div>
          </div>
          <div className="stat-icon">
            <Layers size={24} />
          </div>
        </div>

        <div className="stat-card glass-panel glass-panel-interactive">
          <div>
            <div className="stat-label">Static Stickers</div>
            <div className="stat-value">{staticCount}</div>
          </div>
          <div className="stat-icon green">
            <CheckCircle size={24} />
          </div>
        </div>

        <div className="stat-card glass-panel glass-panel-interactive">
          <div>
            <div className="stat-label">Animated Stickers</div>
            <div className="stat-value">{animatedCount}</div>
          </div>
          <div className="stat-icon animated">
            <Sparkles size={24} />
          </div>
        </div>
      </section>
    </>
  );
}
