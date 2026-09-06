import { useEffect, useRef, useState } from 'react';
import { Euler, MathUtils, Quaternion } from 'three';
import { Viewer } from './Viewer';
import { Timeline } from './Timeline';
import { Icon } from './Icon';
import { NumberField, Section, TextField, VectorFields } from './Fields';
import { useWorkspace } from './workspace';
import { editObject } from './objects';
import type { ObjectChange } from './objects';
import { diagnostics } from './webmcp';
import { DEFINITIONS } from './capabilities';
import { TOOL_NAMES } from './types';
import type { Vec3 } from './types';

const configurationHint =
  'Initial scene only. Export the current state as initial to configure another episode.';
const poseHint = 'Return to latest and wait for the active operation to edit.';

export function ViewportPanel() {
  const { world, command } = useWorkspace();
  return (
    <div className="viewport-editor" data-shortcuts="viewport">
      <div className="viewport-toolbar">
        <span className="editor-kind">
          <Icon name="cube" /> Object Mode
        </span>
        <span className="toolbar-divider" />
        <span className="subtle">World</span>
        <span className="toolbar-spacer" />
        <button
          className={'text-button ' + (world.view.mode === 'camera' ? 'active' : '')}
          aria-label="Camera View"
          aria-pressed={world.view.mode === 'camera'}
          data-hint="Camera View · Numpad 0 / C"
          disabled={world.busy}
          onClick={() => {
            if (world.view.mode !== 'camera') world.toggleCameraView();
          }}
        >
          Camera View
        </button>
        <button
          className={'text-button ' + (world.view.mode === 'free' ? 'active' : '')}
          aria-label="Free View"
          aria-pressed={world.view.mode === 'free'}
          data-hint="Free View · Navigation never changes the scene camera"
          disabled={world.busy}
          onClick={() => {
            if (world.view.mode !== 'free') world.toggleCameraView();
          }}
        >
          Free View
        </button>
        <button
          className="icon-button"
          title="Frame scene"
          aria-label="Frame scene"
          disabled={world.busy}
          onClick={() => command('frameAll')}
        >
          <Icon name="frame" />
        </button>
        <button
          className={'icon-button ' + (world.display.grid ? 'active' : '')}
          title="Toggle grid"
          aria-label="Toggle grid"
          onClick={() => {
            world.display.grid = !world.display.grid;
            world.notify();
          }}
        >
          <Icon name="grid" />
        </button>
        <button
          className={'text-button ' + (world.display.wireframe ? 'active' : '')}
          onClick={() => {
            world.display.wireframe = !world.display.wireframe;
            world.notify();
          }}
        >
          {world.display.wireframe ? 'Wireframe' : 'Solid'}
        </button>
      </div>
      <div className="viewport-stage">
        <Viewer world={world} />
        <div className="viewport-caption">
          <span>{world.view.mode === 'camera' ? 'Camera Perspective' : 'User Perspective'}</span>
          <small>
            {world.cameraSelected
              ? 'Camera'
              : world.selected.length
                ? world.selected.length + ' selected'
                : world.episode.manifest.objects.length + ' objects'}
          </small>
        </div>
      </div>
    </div>
  );
}

function InlineName({
  name,
  onCommit,
  onClose,
}: {
  name: string;
  onCommit: (value: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null),
    cancel = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="inline-name"
      aria-label="Rename"
      defaultValue={name}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (!cancel.current && e.target.value !== name) onCommit(e.target.value);
        onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancel.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function ObjectsPanel() {
  const { world, run, command } = useWorkspace();
  const [query, setQuery] = useState(''),
    [collapsed, setCollapsed] = useState(new Set<string>()),
    [rename, setRename] = useState<string | null>(null),
    [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null),
    request = useRef(world.renameRequested);
  useEffect(() => {
    if (request.current !== world.renameRequested) {
      request.current = world.renameRequested;
      if (world.canConfigure)
        setRename(world.activeGroup ?? (world.selected.length === 1 ? world.selected[0] : null));
    }
  }, [world, world.renameRequested]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    menuRef.current?.focus();
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
    };
  }, [menu]);
  const groups = world.currentFrame.groups,
    objects = world.episode.manifest.objects;
  const matches = (name: string, id: string) =>
    !query || [name, id].some((s) => s.toLowerCase().includes(query.toLowerCase()));
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const context = (e: React.MouseEvent, action: () => void) => {
    e.preventDefault();
    if (world.busy) return;
    action();
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 210),
      y: Math.min(e.clientY, window.innerHeight - 270),
    });
  };
  const localToggle = (ids: string[], key: 'hidden' | 'locked') => {
    const values = world.view[key],
      all = ids.every((id) => values.has(id));
    for (const id of ids) {
      if (all) values.delete(id);
      else values.add(id);
    }
    world.notify();
  };
  const row = (id: string, nested = false) => {
    const o = objects.find((o) => o.id === id)!;
    return (
      <div
        role="treeitem"
        data-object-id={id}
        aria-selected={world.selected.includes(id)}
        tabIndex={0}
        key={id}
        className={
          'object-row ' +
          (nested ? 'nested ' : '') +
          (world.selected.includes(id) ? 'selected ' : '') +
          (world.view.hidden.has(id) ? 'dimmed' : '')
        }
        onClick={(e) => world.select([id], e.shiftKey || e.metaKey || e.ctrlKey)}
        onDoubleClick={() => world.canConfigure && setRename(id)}
        onContextMenu={(e) =>
          context(e, () => {
            if (!world.selected.includes(id)) world.select([id]);
          })
        }
      >
        <Icon name="cube" />
        <span className="object-name">
          {rename === id ? (
            <InlineName
              name={o.name}
              onCommit={(name) => run(() => world.renameObject(id, name))}
              onClose={() => setRename(null)}
            />
          ) : (
            o.name
          )}
        </span>
        <button
          className="row-icon"
          aria-label={'Hide ' + o.name}
          aria-pressed={world.view.hidden.has(id)}
          data-hint="Hide in editor · Does not affect physics or agent capture"
          onClick={(e) => {
            e.stopPropagation();
            localToggle([id], 'hidden');
          }}
        >
          <Icon name="eye" size={13} />
        </button>
        <button
          className="row-icon"
          aria-label={'Lock selection ' + o.name}
          aria-pressed={world.view.locked.has(id)}
          data-hint="Prevent viewport picking · Manage the object in this tree"
          onClick={(e) => {
            e.stopPropagation();
            localToggle([id], 'locked');
          }}
        >
          <Icon name="lock" size={13} />
        </button>
      </div>
    );
  };
  const grouped = new Set(groups.flatMap((g) => g.members));
  return (
    <div className="outliner" data-shortcuts="objects" tabIndex={0}>
      <div className="outliner-search">
        <Icon name="search" size={14} />
        <input
          aria-label="Search objects"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span>{objects.length}</span>
      </div>
      <div role="tree" aria-label="Scene objects">
        <div className="tree-heading">
          <Icon name="cube" size={14} />
          {world.episode.manifest.name}
        </div>
        {matches('Camera', 'camera') && (
          <div
            role="treeitem"
            aria-selected={world.cameraSelected}
            tabIndex={0}
            className={'object-row ' + (world.cameraSelected ? 'selected' : '')}
            onClick={() => world.selectCamera()}
          >
            <Icon name="camera" />
            <span className="object-name">Camera</span>
            <button
              className="row-icon"
              aria-label="Show camera helper"
              aria-pressed={world.view.cameraVisible}
              data-hint="Show the camera and frustum in Free View"
              onClick={(e) => {
                e.stopPropagation();
                world.view.cameraVisible = !world.view.cameraVisible;
                world.notify();
              }}
            >
              <Icon name="eye" size={13} />
            </button>
          </div>
        )}
        {groups.map((g) => {
          const groupMatch = matches(g.name, g.id),
            members = g.members.filter((id) => {
              const o = objects.find((o) => o.id === id)!;
              return groupMatch || matches(o.name, id);
            });
          if (!members.length) return null;
          const expanded = !!query || !collapsed.has(g.id);
          return (
            <div
              key={g.id}
              role="treeitem"
              aria-expanded={expanded}
              aria-selected={world.activeGroup === g.id}
            >
              <div
                className={'group-row ' + (world.activeGroup === g.id ? 'selected' : '')}
                tabIndex={0}
                onClick={() => world.selectGroup(g.id)}
                onDoubleClick={() => world.canConfigure && setRename(g.id)}
                onContextMenu={(e) => context(e, () => world.selectGroup(g.id))}
              >
                <button
                  className="row-icon"
                  aria-label={(expanded ? 'Collapse ' : 'Expand ') + g.name}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(g.id);
                  }}
                >
                  <Icon
                    name="chevron"
                    style={{ transform: expanded ? 'none' : 'rotate(-90deg)' }}
                    size={12}
                  />
                </button>
                <Icon name="group" size={14} />
                <span className="object-name">
                  {rename === g.id ? (
                    <InlineName
                      name={g.name}
                      onCommit={(name) => run(() => world.renameGroup(g.id, name))}
                      onClose={() => setRename(null)}
                    />
                  ) : (
                    g.name
                  )}
                </span>
                <small>{g.members.length}</small>
                <button
                  className="row-icon"
                  aria-label={'Hide ' + g.name}
                  aria-pressed={g.members.every((id) => world.view.hidden.has(id))}
                  onClick={(e) => {
                    e.stopPropagation();
                    localToggle(g.members, 'hidden');
                  }}
                >
                  <Icon name="eye" size={13} />
                </button>
              </div>
              {expanded && <div role="group">{members.map((id) => row(id, true))}</div>}
            </div>
          );
        })}
        {objects.filter((o) => !grouped.has(o.id) && matches(o.name, o.id)).map((o) => row(o.id))}
      </div>
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
        >
          {(['rename', 'frame', 'group', 'ungroup', 'delete'] as const).map((cmd, i) => (
            <button
              role="menuitem"
              key={cmd}
              disabled={
                world.busy ||
                ((cmd === 'rename' || cmd === 'delete') && !world.canConfigure) ||
                (cmd === 'group' && (world.selected.length < 2 || world.cursor !== null)) ||
                (cmd === 'ungroup' && (!world.activeGroup || world.cursor !== null))
              }
              onClick={() => {
                setMenu(null);
                command(cmd);
              }}
            >
              {['Rename', 'Frame Selected', 'Group', 'Ungroup', 'Delete'][i]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PropertiesPanel() {
  const { world, run, replace } = useWorkspace();
  const [force, setForce] = useState([4, 0, 0]);
  if (world.cameraSelected) return <CameraProperties />;
  if (world.activeGroup) {
    const group = world.currentFrame.groups.find((g) => g.id === world.activeGroup);
    if (group)
      return (
        <div className="panel">
          <TextField
            label="Group name"
            value={group.name}
            disabled={!world.canConfigure}
            onChange={(name) => run(() => world.renameGroup(group.id, name))}
          />
          <div className="property-stat">
            Objects <span>{group.members.length}</span>
          </div>
          <Section title="Advanced">
            <CopyID id={group.id} />
          </Section>
        </div>
      );
  }
  const selected = world.selected[0];
  if (!selected) return <div className="empty">No selection</div>;
  if (world.selected.length > 1)
    return (
      <div className="panel">
        <h3>{world.selected.length} Objects</h3>
        <div className="property-stat">
          Transform <span>Median Point</span>
        </div>
      </div>
    );
  const object = world.object(selected, world.viewedData()),
    locked = world.busy || world.cursor !== null || !object.movable;
  const configure = !world.canConfigure,
    collisionReason = world.collisionReason(selected);
  const colliders = object.geometries.filter((g) => g.collidable),
    frictions = colliders.map((g) => g.friction[0]);
  const friction = frictions.every((v) => v === frictions[0]) ? frictions[0] : undefined;
  const q = object.quaternion,
    euler = new Euler().setFromQuaternion(new Quaternion(q[1], q[2], q[3], q[0]), 'XYZ');
  const physics = (change: ObjectChange) =>
    run(async () => replace(await editObject(world, selected, change)));
  return (
    <div className="panel" data-hint={configure ? configurationHint : undefined}>
      <TextField
        label="Object name"
        value={object.name}
        disabled={configure}
        onChange={(name) => run(() => world.renameObject(selected, name))}
      />
      <Section title="Transform" open>
        <VectorFields
          label="Position"
          values={object.position}
          disabled={locked}
          hint={locked ? poseHint : ''}
          onChange={(position) =>
            run(() => world.execute('set_object_pose', { id: selected, position }))
          }
        />
        <VectorFields
          label="Rotation"
          values={[euler.x, euler.y, euler.z].map(MathUtils.radToDeg)}
          disabled={locked}
          hint="Euler XYZ · Degrees"
          onChange={(angles) => {
            const q = new Quaternion().setFromEuler(
              new Euler(...(angles.map(MathUtils.degToRad) as [number, number, number]), 'XYZ'),
            );
            run(() =>
              world.execute('set_object_pose', { id: selected, quaternion: [q.w, q.x, q.y, q.z] }),
            );
          }}
        />
      </Section>
      <Section title="Physics" open>
        <NumberField
          label="Mass"
          value={object.mass}
          disabled={configure || !object.movable}
          hint={world.episode.manifest.units === 'SI' ? 'Mass · kg' : 'Mass · Normalized units'}
          onChange={(mass) => physics({ mass })}
        />
        <label
          className="check"
          data-hint={collisionReason || 'Use existing collision geometry and filtering'}
        >
          <input
            aria-label="Object collision"
            type="checkbox"
            disabled={configure || !!collisionReason}
            checked={!collisionReason && object.collisionEnabled !== false}
            onChange={(e) => run(() => world.setCollisionEnabled(selected, e.target.checked))}
          />
          Collision
        </label>
        <NumberField
          label="Sliding friction"
          value={friction}
          disabled={configure || !!collisionReason}
          hint={collisionReason || 'Applies to existing collision geometries'}
          onChange={(slidingFriction) => physics({ slidingFriction })}
        />
      </Section>
      <Section title="Advanced">
        <CopyID id={object.id} />
        <VectorFields
          label="Quaternion"
          values={q}
          disabled={locked}
          onChange={(quaternion) =>
            run(() => world.execute('set_object_pose', { id: selected, quaternion }))
          }
        />
        <VectorFields
          label="Center of mass"
          values={object.centerOfMass}
          disabled={configure || !object.movable}
          onChange={(centerOfMass) => physics({ centerOfMass })}
        />
        <VectorFields
          label="Principal inertia"
          values={object.inertia}
          disabled={configure || !object.movable}
          onChange={(inertia) => physics({ inertia })}
        />
        <VectorFields
          label="Inertia quaternion"
          values={object.inertiaQuaternion}
          disabled={configure || !object.movable}
          onChange={(inertiaQuaternion) => physics({ inertiaQuaternion })}
        />
        {object.geometries.map((g, i) => (
          <Section title={'Geometry ' + (i + 1)} key={g.index}>
            <div className="property-stat">
              Type{' '}
              <span>
                {['Plane', '', 'Sphere', 'Capsule', 'Ellipsoid', 'Cylinder', 'Box', 'Mesh'][g.type]}
              </span>
            </div>
            {g.collidable && (
              <>
                <label className="field">
                  <span>Contact dimension</span>
                  <select
                    aria-label={'Geometry ' + (i + 1) + ' contact dimension'}
                    value={g.condim}
                    disabled={configure || !!collisionReason}
                    onChange={(e) =>
                      physics({ geometry: { index: g.index, condim: Number(e.target.value) } })
                    }
                  >
                    {[1, 3, 4, 6].map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </label>
                {['Sliding', 'Torsional', 'Rolling'].map((label, j) => (
                  <NumberField
                    key={j}
                    label={'Geometry ' + (i + 1) + ' ' + label.toLowerCase() + ' friction'}
                    value={g.friction[j]}
                    hint={g.condim < [3, 4, 6][j] ? 'Inactive at this contact dimension' : ''}
                    disabled={configure || !!collisionReason || g.condim < [3, 4, 6][j]}
                    onChange={(n) =>
                      physics({
                        geometry: {
                          index: g.index,
                          friction: g.friction.map((v, k) => (k === j ? n : v)),
                        },
                      })
                    }
                  />
                ))}
              </>
            )}
          </Section>
        ))}
        <VectorFields
          label="Angular velocity"
          values={object.velocity.slice(0, 3)}
          disabled
          onChange={() => {}}
        />
        <VectorFields
          label="Linear velocity"
          values={object.velocity.slice(3)}
          disabled
          onChange={() => {}}
        />
      </Section>
      {world.config.physics.enabled && (
        <Section title="Force">
          <VectorFields label="Force" values={force} onChange={setForce} />
          <button
            disabled={locked}
            onClick={() => run(() => world.execute('apply_force', { id: selected, force }))}
          >
            Apply Force
          </button>
        </Section>
      )}
    </div>
  );
}
function CopyID({ id }: { id: string }) {
  const { run } = useWorkspace();
  return (
    <div className="copy-id">
      <code className="selectable">{id}</code>
      <button className="text-button" onClick={() => run(() => navigator.clipboard.writeText(id))}>
        Copy ID
      </button>
    </div>
  );
}
function CameraProperties() {
  const { world, run } = useWorkspace(),
    camera = world.currentFrame.camera,
    locked = world.busy || world.cursor !== null;
  return (
    <div className="panel" data-hint={locked ? poseHint : undefined}>
      <h3>
        <Icon name="camera" /> Camera
      </h3>
      <VectorFields
        label="Camera position"
        values={camera.position}
        disabled={locked}
        onChange={(position) =>
          run(() => world.updateCamera({ ...camera, position: position as Vec3 }))
        }
      />
      <VectorFields
        label="Camera target"
        values={camera.target}
        disabled={locked}
        onChange={(target) => run(() => world.updateCamera({ ...camera, target: target as Vec3 }))}
      />
      <div className="property-stat">
        Lens <span>38° · Z Up</span>
      </div>
      <button
        disabled={locked || world.view.mode !== 'free'}
        data-hint={locked ? poseHint : 'Set the scene camera to the current free view'}
        onClick={() => run(() => world.updateCamera(world.view.camera))}
      >
        Align Camera to View
      </button>
    </div>
  );
}
export function PhysicsPanel() {
  const { world, run } = useWorkspace(),
    p = world.config.physics,
    locked = !world.canConfigure;
  const update = (patch: object) =>
    run(() => world.configure({ ...world.config, physics: { ...p, ...patch } }));
  return (
    <div className="panel" data-hint={locked ? configurationHint : undefined}>
      <TextField
        label="Scene name"
        value={world.episode.manifest.name}
        disabled={locked}
        onChange={(name) => run(() => world.setMetadata({ name }))}
      />
      <label className="field" data-hint="Unit metadata · Existing geometry is not rescaled">
        <span>Units</span>
        <select
          aria-label="Units"
          disabled={locked}
          value={world.episode.manifest.units}
          onChange={(e) =>
            run(() => world.setMetadata({ units: e.target.value as 'SI' | 'normalized' }))
          }
        >
          <option value="SI">SI</option>
          <option value="normalized">Normalized</option>
        </select>
      </label>
      <Section title="Physics" open>
        {(['enabled', 'detection', 'response'] as const).map((k, i) => (
          <label className="check" key={k}>
            <input
              type="checkbox"
              disabled={locked}
              checked={p[k]}
              onChange={(e) => update({ [k]: e.target.checked })}
            />
            {['Enable physics', 'Collision detection', 'Collision response'][i]}
          </label>
        ))}
        <VectorFields
          label="Gravity"
          values={p.gravity}
          disabled={locked}
          onChange={(gravity) => update({ gravity })}
        />
        <label
          className="field"
          data-hint="Physics advances inside object operations and remains paused between them"
        >
          <span>After operation</span>
          <select
            aria-label="Physics strategy"
            disabled={locked}
            value={p.strategy}
            onChange={(e) => update({ strategy: e.target.value })}
          >
            <option value="fixed">Fixed duration</option>
            <option value="settle">Settle</option>
          </select>
        </label>
        <NumberField
          label="Duration (s)"
          value={p.duration}
          disabled={locked}
          onChange={(duration) => update({ duration })}
        />
      </Section>
      {p.strategy === 'settle' && (
        <Section title="Settling">
          {(['maxDuration', 'quietDuration', 'linearThreshold', 'angularThreshold'] as const).map(
            (k, i) => (
              <NumberField
                key={k}
                label={
                  ['Timeout (s)', 'Quiet period (s)', 'Linear threshold', 'Angular threshold'][i]
                }
                value={p[k]}
                disabled={locked}
                onChange={(v) => update({ [k]: v })}
              />
            ),
          )}
        </Section>
      )}
    </div>
  );
}
export function ToolsPanel() {
  const { world, run } = useWorkspace();
  return (
    <div className="panel">
      {TOOL_NAMES.map((name) => (
        <label
          className="tool"
          key={name}
          data-hint={world.canConfigure ? DEFINITIONS[name].description : configurationHint}
        >
          <input
            type="checkbox"
            checked={world.config.enabledTools.includes(name)}
            disabled={!world.canConfigure}
            onChange={(e) =>
              run(() =>
                world.configure({
                  ...world.config,
                  enabledTools: TOOL_NAMES.filter((t) =>
                    t === name ? e.target.checked : world.config.enabledTools.includes(t),
                  ),
                }),
              )
            }
          />
          <strong>{name}</strong>
        </label>
      ))}
    </div>
  );
}
export function DisplayPanel() {
  const { world, command } = useWorkspace(),
    view = world.view.mode === 'camera' ? world.currentFrame.camera : world.view.camera;
  return (
    <div className="panel">
      <div className="buttons">
        <button disabled={world.busy} onClick={() => command('camera')}>
          {world.view.mode === 'camera' ? 'Free View' : 'Camera View'}
        </button>
        <button disabled={world.busy} onClick={() => command('frameAll')}>
          Frame All
        </button>
      </div>
      {(['grid', 'wireframe'] as const).map((k) => (
        <label key={k} className="check">
          <input
            type="checkbox"
            checked={world.display[k]}
            onChange={(e) => {
              world.display[k] = e.target.checked;
              world.notify();
            }}
          />
          {k === 'grid' ? 'Grid' : 'Wireframe'}
        </label>
      ))}
      <VectorFields
        label="View position"
        values={view.position}
        disabled={world.busy}
        onChange={(position) => world.setViewCamera({ ...view, position: position as Vec3 })}
      />
      <VectorFields
        label="View target"
        values={view.target}
        disabled={world.busy}
        onChange={(target) => world.setViewCamera({ ...view, target: target as Vec3 })}
      />
    </div>
  );
}
export function HistoryPanel() {
  const { world, run, replace, command } = useWorkspace();
  return (
    <div className="edit-history" data-shortcuts="history" tabIndex={0}>
      <div className="history-toolbar">
        <span className="editor-kind">
          <Icon name="history" /> Edit History
        </span>
        <span className="toolbar-spacer" />
        <button
          className="icon-button"
          aria-label="Undo"
          title="Undo · Cmd/Ctrl Z"
          disabled={!world.canUndo}
          onClick={() => command('undo')}
        >
          <Icon name="undo" />
        </button>
        <button
          className="icon-button"
          aria-label="Redo"
          title="Redo · Cmd/Ctrl Shift Z"
          disabled={!world.canRedo}
          onClick={() => command('redo')}
        >
          <Icon name="redo" />
        </button>
      </div>
      {world.recording ? (
        <div className="empty" data-hint={configurationHint}>
          Recording
        </div>
      ) : (
        <div className="history-list" role="list" aria-label="Edit history">
          {world.editHistory.entries.map((entry, i) => (
            <button
              key={i}
              role="listitem"
              className={
                'history-entry ' +
                (i === world.editHistory.index ? 'active ' : '') +
                (i > world.editHistory.index ? 'undone' : '')
              }
              disabled={!world.canConfigure}
              aria-current={i === world.editHistory.index ? 'step' : undefined}
              onClick={() => run(async () => replace(await world.restoreEdit(i)))}
            >
              <span>{i}</span>
              {entry.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
export function TimelinePanel() {
  const { world } = useWorkspace();
  return <Timeline world={world} />;
}
export function DiagnosticsPanel() {
  const { world } = useWorkspace();
  return (
    <div className="panel">
      <h3>{diagnostics.status}</h3>
      <div className="property-stat">
        Browser API <span>{diagnostics.api ? 'Available' : 'Unavailable'}</span>
      </div>
      <Section title="Registration">
        <p className="selectable">{diagnostics.registered.join(', ') || 'None'}</p>
        <p className="selectable">{diagnostics.native.join(', ') || 'No native discovery'}</p>
      </Section>
      <Section title="Calls" open>
        {(world.episode.calls ?? []).map((c) => (
          <details className="log" key={c.index}>
            <summary>
              <code>{c.name}</code>
              <span>
                {c.status} · {c.state_index}
              </span>
            </summary>
            <pre className="selectable">{JSON.stringify(c, null, 2)}</pre>
          </details>
        ))}
      </Section>
    </div>
  );
}
