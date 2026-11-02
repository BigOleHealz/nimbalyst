import React, { useEffect, useState } from 'react';
import type { LinearPage, LinearProject, LinearProjectImportResult } from '../../../../shared/linear';

export function LinearPanel(): React.JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [projects, setProjects] = useState<LinearProject[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [results, setResults] = useState<LinearProjectImportResult[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await window.electronAPI.invoke('linear:get-settings') as { hasToken: boolean };
        if (cancelled) return;
        setHasToken(settings.hasToken);
        if (settings.hasToken) {
          const page = await window.electronAPI.invoke('linear:projects', {}) as LinearPage<LinearProject>;
          if (!cancelled) { setProjects(page.nodes); setCursor(page.nextCursor); }
        }
      } catch (error) { if (!cancelled) setErrors([error instanceof Error ? error.message : 'Could not load Linear.']); }
      finally { if (!cancelled) setBusy(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const connect = async () => {
    setBusy(true); setErrors([]); setMessage('');
    try {
      const viewer = await window.electronAPI.invoke('linear:connect', { apiKey }) as { name: string };
      setApiKey(''); setHasToken(true); setSelected(new Set()); setProjects([]); setCursor(undefined); setResults([]);
      setMessage(`Connected as ${viewer.name}.`);
      const page = await window.electronAPI.invoke('linear:projects', {}) as LinearPage<LinearProject>;
      setProjects(page.nodes); setCursor(page.nextCursor);
    } catch (error) { setErrors([error instanceof Error ? error.message : 'Could not connect to Linear.']); }
    finally { setBusy(false); }
  };

  const loadMore = async () => {
    setBusy(true); setErrors([]);
    try {
      const page = await window.electronAPI.invoke('linear:projects', { cursor }) as LinearPage<LinearProject>;
      setProjects(previous => [...previous, ...page.nodes.filter(project => !previous.some(item => item.id === project.id))]);
      setCursor(page.nextCursor);
    } catch (error) { setErrors([error instanceof Error ? error.message : 'Could not load projects.']); }
    finally { setBusy(false); }
  };

  const chooseDestination = async () => {
    setBusy(true); setErrors([]);
    try {
      const folder = await window.electronAPI.invoke('linear:choose-destination') as string | null;
      if (folder) setDestination(folder);
    } catch (error) { setErrors([error instanceof Error ? error.message : 'Could not choose a folder.']); }
    finally { setBusy(false); }
  };

  const importProjects = async () => {
    setBusy(true); setErrors([]); setResults([]);
    const targets = projects.filter(project => selected.has(project.id));
    for (let index = 0; index < targets.length; index++) {
      const project = targets[index];
      setMessage(`Importing ${project.name} (${index + 1}/${targets.length})…`);
      try {
        const result = await window.electronAPI.invoke('linear:import-project', { destination, projectId: project.id }) as LinearProjectImportResult;
        setResults(previous => [...previous, result]);
      } catch (error) { setErrors(previous => [...previous, `${project.name}: ${error instanceof Error ? error.message : 'Import failed.'}`]); }
    }
    setMessage('Import finished. Review the results below.'); setBusy(false);
  };

  const inputClass = 'w-full rounded border border-nim bg-nim-secondary px-3 py-2 text-sm text-nim disabled:opacity-50';
  const buttonClass = 'rounded border border-nim px-3 py-2 text-sm hover:bg-nim-hover disabled:opacity-50';
  const allErrors = [...errors, ...results.flatMap(result => result.errors.map(error => `${result.name}: ${error}`))];
  return <section className="linear-settings-panel space-y-4 text-nim select-text">
    <h2 className="text-lg font-semibold">Import from Linear</h2>
    <p className="text-sm text-nim-muted">Create a separate Nimbalyst workspace for each selected Linear project and import all its tickets, including completed tickets. Workspaces appear in your project list. Repeat an import to add missing tickets while preserving local edits.</p>
    <p className="text-sm text-nim-muted">Create a personal API key in Linear → Settings → Security &amp; access with read access to your projects. Your key is encrypted with your OS credential storage. Imports only read from Linear.</p>
    <label className="block space-y-1 text-sm">Personal API key<input className={inputClass} type="password" autoComplete="new-password" disabled={busy} placeholder={hasToken ? 'Saved securely; leave blank to keep' : 'Linear personal API key'} value={apiKey} onChange={event => setApiKey(event.target.value)} /></label>
    <button className={buttonClass} disabled={busy || (!hasToken && !apiKey.trim())} onClick={() => void connect()}>Connect Linear</button>
    {hasToken && <>
      <div className="linear-destination flex flex-wrap items-center gap-2">
        <button className={buttonClass} disabled={busy} onClick={() => void chooseDestination()}>Choose folder</button>
        <span className="text-sm text-nim-muted break-all">{destination || 'Choose where the new workspaces will be created.'}</span>
      </div>
      <fieldset className="linear-project-picker space-y-2" disabled={busy}>
        <legend className="mb-2 text-sm font-medium">Projects</legend>
        {projects.length === 0 && !busy && <p className="text-sm text-nim-muted">No accessible projects found. Check your key’s project access, then connect again.</p>}
        {projects.map(project => <label key={project.id} className="linear-project-row flex items-start gap-3 rounded border border-nim p-3">
          <input type="checkbox" className="mt-1" aria-label={project.name} checked={selected.has(project.id)} onChange={() => setSelected(previous => {
            const next = new Set(previous); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next;
          })} />
          <span className="min-w-0"><span className="block text-sm font-medium">{project.name}</span><span className="block text-xs text-nim-muted">{project.state}{project.description ? ` · ${project.description}` : ''}</span></span>
        </label>)}
      </fieldset>
      {cursor && <button className={buttonClass} disabled={busy} onClick={() => void loadMore()}>Load more projects</button>}
      <div className="linear-import-actions flex items-center gap-3">
        <button className="rounded bg-nim-primary px-3 py-2 text-sm text-white disabled:opacity-50" disabled={busy || !destination || selected.size === 0} onClick={() => void importProjects()}>Import selected projects</button>
        <span className="text-xs text-nim-muted">{selected.size} selected</span>
      </div>
      <p className="text-xs text-nim-muted">For individual tickets, use Trackers → Import → Import from Linear in an existing workspace. Tickets keep a link to Linear; you can pull the latest source changes from the ticket.</p>
    </>}
    {busy && !message && <p role="status" className="text-sm text-nim-muted">Loading…</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {results.map(result => <article key={result.projectId} className="linear-import-result space-y-1 rounded border border-nim p-3">
      <div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">{result.name}</span><button className={buttonClass} disabled={busy} onClick={() => void window.electronAPI.workspaceManager.openWorkspace(result.workspacePath).catch(error => setErrors(previous => [...previous, error instanceof Error ? error.message : 'Could not open workspace.']))}>Open {result.name}</button></div>
      <p className="text-sm">{result.created} tickets imported, {result.skipped} already imported</p>
      <p className="text-xs text-nim-muted break-all">{result.workspacePath}</p>
    </article>)}
    {allErrors.length > 0 && <div role="alert" className="space-y-1 text-sm text-nim-error">{allErrors.map((error, index) => <p key={index}>{error}</p>)}<p>Retry the import after resolving these errors. Existing tickets are preserved.</p></div>}
  </section>;
}
