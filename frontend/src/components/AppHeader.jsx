import { Sparkles, Upload } from 'lucide-react';
import { StatusPopover } from './StatusPopover';
import { JobCenterButton } from './JobCenter';

const NAV_ITEMS = [
  { view: 'library', label: 'Library' },
  { view: 'health', label: 'Health' }
];

export function AppHeader({ view, onNavigate, onImport, importDisabled, status, jobs, onOpenJobs }) {
  return (
    <header className="app-header">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <a
        className="brand"
        href="?"
        onClick={(event) => { event.preventDefault(); onNavigate('library'); }}
        aria-label="Sticker Workspace — Library"
      >
        <span className="brand-mark" aria-hidden="true"><Sparkles size={16} /></span>
        <span className="brand-name">Sticker Workspace</span>
      </a>

      <nav className="primary-nav" aria-label="Primary">
        {NAV_ITEMS.map((item) => (
          <a
            key={item.view}
            href={`?view=${item.view}`}
            aria-current={view === item.view ? 'page' : undefined}
            onClick={(event) => { event.preventDefault(); onNavigate(item.view); }}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <div className="header-actions">
        <JobCenterButton jobs={jobs} onOpen={onOpenJobs} />
        <StatusPopover {...status} onOpenHealth={() => onNavigate('health')} />
        <button type="button" className="btn btn-primary" onClick={onImport} disabled={importDisabled}>
          <Upload size={16} aria-hidden="true" />
          <span>Import</span>
        </button>
      </div>
    </header>
  );
}
