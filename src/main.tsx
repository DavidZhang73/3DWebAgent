import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DockviewReact, themeDark } from 'dockview-react';
import type { DockviewApi, DockviewReadyEvent } from 'dockview-react';
import loadMujoco from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import { World } from './runtime';
import { Icon } from './Icon';
import { IconButton, EditorTooltip } from './EditorControls';
import type { PropertyCategory } from './workspace';
import type { IconName } from './Icon';
import { Menu } from './Menu';
import { useFileDrop } from './useFileDrop';
import { THEMES, flavors, savedTheme, applyTheme } from './theme';
import type { ThemeName } from './theme';
import { decodeEpisode, encodeEpisode } from './archive';
import { importOBJ, removeObjects } from './objects';
import { diagnostics, registerTools } from './webmcp';
import { WorkspaceContext, shortcut } from './workspace';
import type { Command } from './workspace';
import {
  ViewportPanel,
  ObjectsPanel,
  PropertiesPanel,
  PhysicsPanel,
  ToolsPanel,
  DisplayPanel,
  TimelinePanel,
  DiagnosticsPanel,
  HistoryPanel,
} from './Panels';
import 'dockview-react/dist/styles/dockview.css';
import './style.css';
let engine: ReturnType<typeof loadMujoco>;
World.engine = () =>
  (engine ??= loadMujoco({ locateFile: (p: string) => (p.endsWith('.wasm') ? wasmUrl : p) }));
World.captureFactory = async (world) =>
  (await import('./agent-renderer')).createAgentRenderer(world);
const components = {
  viewport: ViewportPanel,
  objects: ObjectsPanel,
  properties: PropertiesPanel,
  physics: PhysicsPanel,
  tools: ToolsPanel,
  display: DisplayPanel,
  timeline: TimelinePanel,
  diagnostics: DiagnosticsPanel,
  editHistory: HistoryPanel,
};
const titles = {
  viewport: '3D Viewport',
  objects: 'Objects',
  properties: 'Properties',
  physics: 'World',
  tools: 'WebMCP',
  display: 'Display',
  timeline: 'Timeline',
  diagnostics: 'WebMCP Diagnostics',
  editHistory: 'Edit History',
};
function defaultLayout(api: DockviewApi, recording = false) {
  api.clear();
  api.addPanel({
    id: 'viewport',
    component: 'viewport',
    title: titles.viewport,
    renderer: 'always',
  });
  api.addPanel({
    id: 'objects',
    component: 'objects',
    title: titles.objects,
    position: { referencePanel: 'viewport', direction: 'right' },
    initialWidth: 330,
  });
  api.addPanel({
    id: 'properties',
    component: 'properties',
    title: titles.properties,
    position: { referencePanel: 'objects', direction: 'below' },
    initialHeight: 470,
  });
  api.addPanel({
    id: 'timeline',
    component: 'timeline',
    title: titles.timeline,
    position: { referencePanel: 'viewport', direction: 'below' },
    initialHeight: 230,
  });
  api.addPanel({
    id: 'editHistory',
    component: 'editHistory',
    title: titles.editHistory,
    position: { referencePanel: 'timeline', direction: 'within' },
  });
  api.getPanel('properties')?.api.setActive();
  api.getPanel(recording ? 'timeline' : 'editHistory')?.api.setActive();
}
function App() {
  const [propertyCategory, setPropertyCategory] = useState<PropertyCategory>(() => {
    try {
      const saved = localStorage.getItem('3dwebagent.property-category');
      if (['object', 'physics', 'world', 'display', 'webmcp'].includes(saved ?? ''))
        return saved as PropertyCategory;
    } catch {
      /* Storage may be unavailable in private browser contexts. */
    }
    return 'object';
  });
  useEffect(() => {
    try {
      localStorage.setItem('3dwebagent.property-category', propertyCategory);
    } catch {
      /* Keep the current session usable without persistence. */
    }
  }, [propertyCategory]);
  const [hint, setHint] = useState(''),
    [details, setDetails] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(savedTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const [world, setWorld] = useState<World>(),
    [version, setVersion] = useState(0),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [saved, setSaved] = useState<{ url: string; name: string }>();
  const api = useRef<DockviewApi | undefined>(undefined),
    episodeInput = useRef<HTMLInputElement>(null),
    objInput = useRef<HTMLInputElement>(null),
    opening = useRef(false);
  const redraw = () => setVersion((v) => v + 1);
  useEffect(() => {
    let alive = true;
    (async () => {
      let next: World;
      const url = new URLSearchParams(location.search).get('episode');
      if (url) {
        try {
          const source = new URL(url, location.href);
          if (!['http:', 'https:'].includes(source.protocol))
            throw new Error('Episode URL must use HTTP(S).');
          const r = await fetch(source);
          if (!r.ok) throw new Error('Episode download failed: ' + r.status);
          const ep = await decodeEpisode(new File([await r.blob()], 'episode.zip'));
          next = await World.create(ep.assets, ep);
        } catch (e) {
          setError(String(e));
          next = await World.create();
        }
      } else {
        next = await World.create();
        if (new URLSearchParams(location.search).has('world'))
          setError('The world URL format was removed. Load a format-3 episode.');
      }
      if (alive) setWorld(next);
      else next.dispose();
    })()
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!world) return;
    const unsub = world.subscribe(redraw);
    return () => {
      unsub();
      world.dispose();
    };
  }, [world]);
  const toolKey = world?.config.enabledTools.join(',');
  useEffect(() => (world ? registerTools(world, redraw) : undefined), [world, toolKey]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (world?.dirty || world?.busy) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [world]);
  useEffect(
    () => () => {
      if (saved) URL.revokeObjectURL(saved.url);
    },
    [saved],
  );
  const run = async (action: () => Promise<unknown> | unknown) => {
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const replace = (next: World) => {
    setWorld(next);
    setSaved(undefined);
  };
  const load = async (file: File) => {
    if (opening.current || loading || world?.busy)
      throw new Error('Wait for the current operation before opening an episode.');
    if (!file.name.toLowerCase().endsWith('.zip')) throw new Error('Choose an episode ZIP file.');
    if (world?.dirty && !confirm('Replace the unsaved scene? Export it first to keep it.')) return;
    opening.current = true;
    setLoading(true);
    if (world) {
      world.busy = true;
      world.notify();
    }
    try {
      const ep = await decodeEpisode(file);
      replace(await World.create(ep.assets, ep));
    } finally {
      opening.current = false;
      setLoading(false);
      if (world) {
        world.busy = false;
        world.notify();
      }
    }
  };
  const dropDisabled = loading || !!world?.busy;
  const fileDragging = useFileDrop((files) => {
    void run(() => {
      if (files.length !== 1) throw new Error('Drop one episode ZIP file at a time.');
      return load(files[0]);
    });
  }, dropDisabled);
  const save = async (initial: boolean) => {
    if (!world || world.busy) return;
    if (initial && world.traceCursor !== null)
      throw new Error('Select a committed state before exporting an initial scene.');
    const savedRevision = world.episode.revision,
      savedEntry = world.editHistory.entries[world.editHistory.index];
    const bytes = await encodeEpisode(world.episode, initial ? world.currentFrame : undefined);
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(bytes).buffer], { type: 'application/zip' }),
    );
    const name =
      (world.episode.manifest.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'scene') +
      (initial ? '.initial' : '') +
      '.episode.zip';
    setSaved({ url, name });
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    if (
      !initial &&
      savedRevision === world.episode.revision &&
      savedEntry === world.editHistory.entries[world.editHistory.index]
    )
      world.markSaved();
  };
  const onReady = ({ api: layout }: DockviewReadyEvent) => {
    api.current = layout;
    try {
      const saved =
        localStorage.getItem('3dwebagent.layout.v4') ??
        localStorage.getItem('3dwebagent.layout.v3');
      if (saved) {
        const json = JSON.parse(saved);
        if (json.popoutGroups?.length) throw new Error('Popouts disabled');
        layout.fromJSON(json);
        if (!layout.panels.length) defaultLayout(layout, !!world?.recording);
      } else defaultLayout(layout, !!world?.recording);
    } catch {
      defaultLayout(layout, !!world?.recording);
    }
    // Consolidate legacy property panels in place, preserving the surrounding dock geometry.
    const aliases = { physics: 'world', display: 'display', tools: 'webmcp' } as const;
    const legacy = layout.panels.filter((panel) => panel.id in aliases);
    const activeLegacy = layout.activePanel?.id;
    if (legacy.length && !layout.getPanel('properties'))
      layout.addPanel({
        id: 'properties',
        component: 'properties',
        title: 'Properties',
        position: { referencePanel: legacy[0].id, direction: 'within' },
      });
    for (const panel of legacy) layout.removePanel(panel);
    if (activeLegacy && activeLegacy in aliases) {
      setPropertyCategory(aliases[activeLegacy as keyof typeof aliases]);
      layout.getPanel('properties')?.api.setActive();
    }
    if (!layout.getPanel('editHistory'))
      layout.addPanel({
        id: 'editHistory',
        component: 'editHistory',
        title: titles.editHistory,
        renderer: 'always',
        ...(layout.getPanel('timeline')
          ? { position: { referencePanel: 'timeline', direction: 'within' as const } }
          : {}),
      });
    for (const panel of layout.panels) {
      const title = titles[panel.id as keyof typeof titles];
      if (title) panel.api.setTitle(title);
    }
    layout.getPanel(world?.recording ? 'timeline' : 'editHistory')?.api.setActive();
    try {
      localStorage.setItem('3dwebagent.layout.v4', JSON.stringify(layout.toJSON()));
    } catch {
      /* Layout persistence is optional. */
    }
    layout.onDidLayoutChange(() => {
      try {
        localStorage.setItem('3dwebagent.layout.v4', JSON.stringify(layout.toJSON()));
      } catch {}
    });
  };
  const openPanel = (requested: keyof typeof titles | 'objectPhysics') => {
    const categories: Partial<Record<keyof typeof titles | 'objectPhysics', PropertyCategory>> = {
      properties: 'object',
      objectPhysics: 'physics',
      physics: 'world',
      display: 'display',
      tools: 'webmcp',
    };
    const category = categories[requested];
    const id = category ? 'properties' : (requested as keyof typeof titles);
    if (category) setPropertyCategory(category);
    const panel = api.current?.getPanel(id);
    if (panel) panel.api.setActive();
    else api.current?.addPanel({ id, component: id, title: titles[id], renderer: 'always' });
  };
  const newScene = () =>
    run(async () => {
      if (!world?.dirty || confirm('Replace the unsaved scene?')) replace(await World.create());
    });
  const mode = (value: 'select' | 'translate' | 'rotate') => {
    if (!world) return;
    world.display.manipulator = value !== 'select';
    if (value !== 'select') world.display.gizmo = value;
    world.notify();
  };
  const toolButton = (
    name: string,
    icon: IconName,
    action: () => void,
    active = false,
    disabled = false,
  ) => (
    <IconButton
      icon={icon}
      label={name}
      large
      className="activity-button"
      active={active}
      disabled={disabled}
      disabledReason="Wait for the active operation."
      shortcut={icon === 'move' ? 'G' : icon === 'rotate' ? 'R' : icon === 'frame' ? 'Home' : ''}
      onClick={action}
    />
  );
  const command = (name: Command) =>
    void run(async () => {
      if (!world) return;
      if (name === 'undo' || name === 'redo') {
        if (name === 'undo' ? world.canUndo : world.canRedo)
          replace(await world.restoreEdit(world.editHistory.index + (name === 'undo' ? -1 : 1)));
        return;
      }
      if (world.busy) return;
      if (name === 'delete') {
        if (world.canConfigure && world.selected.length)
          replace(await removeObjects(world, world.selected));
        return;
      }
      if (name === 'rename') {
        if (world.canConfigure && !world.cameraSelected) {
          openPanel('objects');
          world.renameRequested++;
          world.notify();
        }
        return;
      }
      if (name === 'group') {
        if (world.selected.length >= 2 && world.cursor === null)
          await world.execute('group_objects', { ids: world.selected });
        return;
      }
      if (name === 'ungroup') {
        const ids = world.currentFrame.groups
          .filter(
            (g) =>
              g.id === world.activeGroup || g.members.every((id) => world.selected.includes(id)),
          )
          .map((g) => g.id);
        if (ids.length && world.cursor === null) {
          await world.execute('ungroup_objects', { ids });
          world.activeGroup = null;
        }
        return;
      }
      if (name === 'selectAll') {
        world.select(world.episode.manifest.objects.map((o) => o.id));
        return;
      }
      if (name === 'deselect') {
        world.select([]);
        return;
      }
      if (name === 'move' || name === 'rotate') {
        openPanel('viewport');
        await new Promise(requestAnimationFrame);
        world.interaction?.begin(name === 'move' ? 'translate' : 'rotate');
        return;
      }
      if (name === 'camera') {
        world.toggleCameraView();
        return;
      }
      if (name === 'frame' || name === 'frameAll') {
        world.frameSelection(name === 'frameAll');
        return;
      }
      if (name === 'play') {
        openPanel('timeline');
        await new Promise(requestAnimationFrame);
        world.playback?.();
      }
    });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        document.querySelector('.app-menu[open],.context-menu,.editor-popover')
      )
        return;
      const target = event.target as Element,
        area = target.closest?.('[data-shortcuts]')?.getAttribute('data-shortcuts');
      const action = shortcut(event);
      if (!action) return;
      const global = action === 'undo' || action === 'redo';
      if (!global && !area) return;
      if (area === 'timeline' && action !== 'play') return;
      if (action === 'play' && !['viewport', 'timeline'].includes(area ?? '')) return;
      event.preventDefault();
      command(action);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const recording = world?.recording;
  useEffect(() => {
    api.current?.getPanel(recording ? 'timeline' : 'editHistory')?.api.setActive();
  }, [recording]);
  const showHint = (target: EventTarget) => {
    if (!(target instanceof Element)) return;
    const el = target.closest('[data-hint],[title]');
    setHint(el?.getAttribute('data-hint') || el?.getAttribute('title') || '');
  };
  return (
    <div
      className="app"
      onPointerOver={(e) => showHint(e.target)}
      onFocus={(e) => showHint(e.target)}
    >
      {fileDragging && <div className="episode-drop-indicator" aria-hidden="true" />}
      <header className="menubar">
        <span className="app-logo" title="3DWebAgent">
          <Icon name="cube" size={20} />
        </span>
        <nav aria-label="Application menu">
          <Menu label="File">
            <button disabled={loading || world?.busy} onClick={newScene}>
              <Icon name="file" />
              New scene
            </button>
            <button disabled={loading || world?.busy} onClick={() => episodeInput.current?.click()}>
              Open episode…
            </button>
            <button
              aria-label="Import OBJ"
              disabled={!world?.canEditModel || loading}
              onClick={() => objInput.current?.click()}
            >
              Import OBJ…
            </button>
            <hr />
            <button disabled={!world || world.busy} onClick={() => run(() => save(false))}>
              <Icon name="save" />
              Export full episode…
            </button>
            <button disabled={!world || world.busy} onClick={() => run(() => save(true))}>
              Export current as initial…
            </button>
          </Menu>
          <Menu label="Edit">
            <button disabled={!world?.canUndo} onClick={() => command('undo')}>
              <Icon name="undo" />
              Undo<kbd>⌘ / Ctrl Z</kbd>
            </button>
            <button disabled={!world?.canRedo} onClick={() => command('redo')}>
              <Icon name="redo" />
              Redo<kbd>⇧ ⌘ / Ctrl Z</kbd>
            </button>
            <hr />
            <button
              disabled={!world || world.busy || world.cursor !== null}
              onClick={() => command('move')}
            >
              Move<kbd>G</kbd>
            </button>
            <button
              disabled={!world || world.busy || world.cursor !== null}
              onClick={() => command('rotate')}
            >
              Rotate<kbd>R</kbd>
            </button>
            <button
              disabled={!world?.canConfigure || world.cameraSelected || !world.selected.length}
              onClick={() => command('rename')}
            >
              Rename<kbd>F2</kbd>
            </button>
            <hr />
            <button
              disabled={!world || world.busy || world.cursor !== null || world.selected.length < 2}
              onClick={() => command('group')}
            >
              Group Selected<kbd>⌘ / Ctrl G</kbd>
            </button>
            <button
              disabled={!world || world.busy || world.cursor !== null || !world.selected.length}
              onClick={() => command('ungroup')}
            >
              Ungroup<kbd>⌥ ⌘ / Ctrl G</kbd>
            </button>
            <button
              disabled={!world?.canEditModel || !world.selected.length}
              onClick={() => command('delete')}
            >
              Delete<kbd>Delete</kbd>
            </button>
            <hr />
            <button disabled={!world || world.busy} onClick={() => command('selectAll')}>
              Select All<kbd>A</kbd>
            </button>
            <button disabled={!world || world.busy} onClick={() => command('deselect')}>
              Deselect All<kbd>Alt A</kbd>
            </button>
          </Menu>
          <Menu label="View">
            <button disabled={!world || world.busy} onClick={() => command('camera')}>
              Camera / Free View<kbd>Numpad 0 / C</kbd>
            </button>
            <button disabled={!world || world.busy} onClick={() => command('frame')}>
              Frame Selected<kbd>Numpad . / F</kbd>
            </button>
            <button disabled={!world || world.busy} onClick={() => command('frameAll')}>
              Frame All<kbd>Home</kbd>
            </button>
            <hr />
            {Object.entries({ ...titles, objectPhysics: 'Object Physics' }).map(([id, title]) => (
              <button
                key={id}
                onClick={() => openPanel(id as keyof typeof titles | 'objectPhysics')}
              >
                {title}
              </button>
            ))}
            <hr />
            <button
              onClick={() => {
                const panel = api.current?.activePanel;
                if (panel) api.current?.addFloatingGroup(panel);
              }}
            >
              Float Active Panel
            </button>
            <button onClick={() => api.current && defaultLayout(api.current, !!world?.recording)}>
              Reset layout
            </button>
          </Menu>
          <Menu label="Theme">
            <span className="menu-label">CATPPUCCIN</span>
            {THEMES.map((name) => (
              <button
                className="theme-option"
                key={name}
                onClick={() => setTheme(name)}
                aria-pressed={theme === name}
              >
                <span className="theme-swatches">
                  {(['base', 'blue', 'mauve', 'green'] as const).map((c) => (
                    <i key={c} style={{ background: flavors[name].colors[c].hex }} />
                  ))}
                </span>
                {flavors[name].name}
                <span className="menu-check">{theme === name ? '✓' : ''}</span>
              </button>
            ))}
          </Menu>
        </nav>
        <div className="window-title">
          <Icon name="file" size={13} />
          <span className="selectable">
            {world?.episode.manifest.name ?? 'Untitled'}
            {world?.dirty ? ' •' : ''}
          </span>
          <span className="title-app">— 3DWebAgent</span>
        </div>
        <button className="connection-button" onClick={() => openPanel('diagnostics')}>
          <i className={'indicator ' + (diagnostics.api ? 'connected' : '')} />
          WebMCP
          <Icon name="chevron" size={12} />
        </button>
      </header>
      <input
        ref={episodeInput}
        hidden
        type="file"
        accept=".zip"
        aria-label="Episode file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void run(() => load(file));
          e.target.value = '';
        }}
      />
      <input
        ref={objInput}
        hidden
        type="file"
        multiple
        accept=".obj"
        aria-label="OBJ files"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length && world)
            void run(async () => {
              setLoading(true);
              try {
                replace(await importOBJ(world, files));
              } finally {
                setLoading(false);
              }
            });
          e.target.value = '';
        }}
      />
      {world ? (
        <WorkspaceContext.Provider
          value={{ world, replace, run, command, version, propertyCategory, setPropertyCategory }}
        >
          <div className="workbench">
            <aside className="activitybar" aria-label="Scene tools">
              {toolButton(
                'Select objects',
                'cursor',
                () => mode('select'),
                !world.display.manipulator,
              )}
              {toolButton(
                'Move objects',
                'move',
                () => mode('translate'),
                world.display.manipulator && world.display.gizmo === 'translate',
              )}
              {toolButton(
                'Rotate objects',
                'rotate',
                () => mode('rotate'),
                world.display.manipulator && world.display.gizmo === 'rotate',
              )}
              <span className="activity-divider" />
              {toolButton('Frame scene', 'frame', () => command('frameAll'), false, world.busy)}
            </aside>
            <div className="workspace">
              <DockviewReact
                components={components}
                onReady={onReady}
                theme={themeDark}
                defaultRenderer="always"
              />
            </div>
          </div>
        </WorkspaceContext.Provider>
      ) : (
        <div className="loading">Loading MuJoCo workspace…</div>
      )}
      <EditorTooltip />
      <footer>
        <span className={'indicator ' + (diagnostics.api ? 'connected' : '')} />
        <span className="status-mode">
          {loading
            ? 'Loading'
            : world?.busy
              ? 'Editing'
              : world?.cursor !== null && world?.cursor !== undefined
                ? 'History'
                : world?.recording
                  ? 'Recording'
                  : 'Initial Editor'}
        </span>
        {error || world?.error ? (
          <>
            <button className="status-error" role="alert" onClick={() => setDetails(!details)}>
              {error || world?.error}
            </button>
            <button
              className="text-button"
              onClick={() => {
                setError('');
                setDetails(false);
                if (world) {
                  world.error = '';
                  world.notify();
                }
              }}
            >
              Dismiss
            </button>
          </>
        ) : (
          <span className="status-hint" role="status">
            {(fileDragging
              ? dropDisabled
                ? 'Wait for the current operation before opening an episode.'
                : 'Drop an episode ZIP to open'
              : '') ||
              world?.status ||
              hint ||
              (world?.cursor !== null
                ? 'History is read only · Free View remains available'
                : world?.recording
                  ? 'Operations append to the timeline'
                  : 'Initial scene · G Move · R Rotate · F2 Rename')}
          </span>
        )}
        <span className="connection" data-hint={diagnostics.status}>
          {world?.episode.manifest.units} · {world?.episode.calls?.length ?? 0} calls ·{' '}
          {diagnostics.api ? 'WebMCP' : 'Offline'}
        </span>
        {saved && (
          <a download={saved.name} href={saved.url}>
            Download
          </a>
        )}
      </footer>
      {details && (error || world?.error) && (
        <div className="error-details">
          <pre className="selectable">{error || world?.error}</pre>
          <button onClick={() => openPanel('diagnostics')}>Diagnostics</button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
