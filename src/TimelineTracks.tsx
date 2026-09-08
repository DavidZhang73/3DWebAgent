import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { IconButton } from './EditorControls';
import type { World } from './runtime';
import { frameAtTime, operationAtPixel, trajectoryRange } from './timeline-state';

// Keep seeking bounded to one state restore per animation frame, including long drags.
function useScrub(seek: (x: number) => void, pause: () => void, disabled: boolean) {
  const pending = useRef<number | null>(null),
    token = useRef(0),
    active = useRef(false);
  const current = useRef(seek),
    blocked = useRef(disabled);
  blocked.current = disabled;
  current.current = seek;
  const flush = () => {
    cancelAnimationFrame(token.current);
    token.current = 0;
    if (pending.current !== null && !blocked.current) current.current(pending.current);
    pending.current = null;
  };
  useEffect(() => () => cancelAnimationFrame(token.current), []);
  const queue = (e: ReactPointerEvent<HTMLElement>) => {
    pending.current = e.clientX - e.currentTarget.getBoundingClientRect().left;
    if (!token.current) token.current = requestAnimationFrame(flush);
  };
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (disabled || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      e.currentTarget.focus();
      pause();
      active.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      queue(e);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      if (active.current) queue(e);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      if (!active.current) return;
      queue(e);
      flush();
      active.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
    onLostPointerCapture: () => {
      active.current = false;
      flush();
    },
    onPointerCancel: () => {
      active.current = false;
      flush();
    },
  };
}

export function TimelineTracks({
  world,
  selected,
  playing,
  select,
  pause,
  inspect,
}: {
  world: World;
  selected: number;
  playing: boolean;
  select: (index: number) => void;
  pause: () => void;
  inspect: (index: number) => void;
}) {
  const calls = world.episode.calls ?? [],
    call = calls[selected],
    trace = world.episode.trajectory;
  const scroll = useRef<HTMLDivElement>(null),
    physics = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600),
    [left, setLeft] = useState(0),
    [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(scroll.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setZoom(null);
    setLeft(0);
    if (scroll.current) scroll.current.scrollLeft = 0;
  }, [world]);
  const spacing = zoom ?? Math.max(1, Math.min(100, (width - 48) / Math.max(1, calls.length)));
  const canvasWidth = Math.max(width, 48 + calls.length * spacing);
  const first = Math.max(0, Math.floor((left - 24) / spacing) - 1);
  const last = Math.min(calls.length, Math.ceil((left + width) / spacing) + 1);
  useEffect(() => {
    if (!playing || !scroll.current) return;
    const x = 24 + (selected + 1) * spacing,
      el = scroll.current;
    if (x < el.scrollLeft + 24 || x > el.scrollLeft + el.clientWidth - 24)
      el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
  }, [playing, selected, spacing]);
  const seek = (index: number) => {
    pause();
    select(index);
  };
  const scrub = useScrub(
    (x) => select(operationAtPixel(x, spacing, calls.length) - 1),
    pause,
    world.busy,
  );
  const range = useMemo(
    () => trajectoryRange(trace, call?.trace_start ?? 0, call?.trace_end ?? 0),
    [trace, call, call?.trace_end],
  );
  const hasTrace = !!call && call.trace_end > call.trace_start;
  const frameIndex =
    hasTrace &&
    world.traceCursor !== null &&
    world.traceCursor >= call.trace_start &&
    world.traceCursor < call.trace_end
      ? world.traceCursor
      : hasTrace
        ? call.trace_end - 1
        : 0;
  const frame = hasTrace ? trace[frameIndex] : undefined;
  const seekFrame = (index: number) => {
    if (!hasTrace || world.busy) return;
    pause();
    world.setTraceCursor(Math.max(call.trace_start, Math.min(call.trace_end - 1, index)));
  };
  const physicsScrub = useScrub(
    (x) => {
      const fraction = Math.max(0, Math.min(1, x / physics.current!.clientWidth));
      seekFrame(
        frameAtTime(trace, range.start, range.last, range.origin + fraction * range.duration),
      );
    },
    pause,
    world.busy || !hasTrace,
  );
  const fraction =
    frame && range.duration
      ? Math.max(0, Math.min(1, (frame.sim_time - range.origin) / range.duration))
      : 0;
  return (
    <div className="timeline-tracks">
      <div className="timeline-track-tools">
        <strong>Steps</strong>
        <span>{calls.length} calls</span>
        <IconButton
          icon="minus"
          label="Zoom out timeline"
          description="Show more calls in the visible range."
          onClick={() => setZoom(Math.max(1, spacing / 1.5))}
        />
        <IconButton
          icon="plus"
          label="Zoom in timeline"
          description="Increase spacing between call markers."
          onClick={() => setZoom(Math.min(240, spacing * 1.5))}
        />
        <IconButton
          icon="frame"
          label="Fit"
          description="Fit the recorded calls into the timeline."
          onClick={() => {
            setZoom(null);
            setLeft(0);
            if (scroll.current) scroll.current.scrollLeft = 0;
          }}
        />
      </div>
      <div
        className="timeline-scroll"
        ref={scroll}
        onScroll={(e) => setLeft(e.currentTarget.scrollLeft)}
      >
        <div
          className="call-timeline-canvas"
          style={{ width: canvasWidth }}
          tabIndex={0}
          aria-label="Step timeline"
          role="group"
          aria-disabled={world.busy}
          {...scrub}
          onKeyDown={(e) => {
            if (world.busy || (e.target as HTMLElement).closest('button')) return;
            const n =
              e.key === 'Home'
                ? -1
                : e.key === 'End'
                  ? calls.length - 1
                  : e.key === 'ArrowLeft'
                    ? Math.max(-1, selected - 1)
                    : e.key === 'ArrowRight'
                      ? Math.min(calls.length - 1, selected + 1)
                      : null;
            if (n !== null) {
              e.preventDefault();
              seek(n);
            }
          }}
        >
          <div
            className="timeline-ruler"
            role="slider"
            tabIndex={0}
            aria-label="Step playhead"
            aria-valuemin={0}
            aria-valuemax={calls.length}
            aria-valuenow={selected + 1}
            aria-disabled={world.busy}
          >
            {Array.from({ length: Math.max(0, last - first + 1) }, (_, n) => first + n).map((n) => (
              <span
                className={n % 5 === 0 ? 'major' : ''}
                key={n}
                style={{ left: 24 + n * spacing }}
              >
                {n % Math.max(1, Math.ceil(32 / spacing)) === 0 ? n : ''}
              </span>
            ))}
          </div>
          <div className="call-markers" role="list" aria-label="Recorded calls">
            {calls.map((c, i) => (
              <button
                key={c.id}
                role="listitem"
                className={`call-key ${c.status === 'error' ? 'failed' : ''}`}
                style={{
                  left: 24 + (i + 1) * spacing,
                  width: Math.min(20, spacing),
                  fontSize: spacing < 12 ? 5 : undefined,
                }}
                aria-label={`${i + 1} · ${c.actor} · ${c.name}`}
                aria-current={selected === i ? 'step' : undefined}
                disabled={world.busy}
                data-tooltip={`${i + 1} · ${c.actor} · ${c.name} · ${c.status}\n${c.steps} physics steps · ${(c.sim_end - c.sim_start).toFixed(3)} s${c.error_code ? '\n' + c.error_code : ''}`}
                onClick={() => {
                  seek(i);
                  inspect(i);
                }}
              >
                <span>{c.status === 'error' ? '!' : '◆'}</span>
                <small>
                  {spacing >= 24 || selected === i || (i + 1) % Math.ceil(32 / spacing) === 0
                    ? i + 1
                    : ''}
                </small>
              </button>
            ))}
          </div>
          <div className="timeline-playhead" style={{ left: 24 + (selected + 1) * spacing }}>
            <span>{selected + 1}</span>
          </div>
          {!calls.length && (
            <p className="timeline-empty-note">
              Setup editor · the first agent call starts recording.
            </p>
          )}
        </div>
      </div>
      <div className="physics-subtrack">
        {hasTrace && frame ? (
          <>
            <div className="physics-heading">
              <strong>
                {call.status === 'error' ? 'Failed attempt' : 'Physics'} · Step {selected + 1}
              </strong>
              <IconButton
                icon="previous"
                label="Previous physics frame"
                disabled={world.busy || frameIndex === call.trace_start}
                disabledReason={
                  world.busy
                    ? 'Wait for the active operation.'
                    : 'Already at the first recorded frame.'
                }
                onClick={() => seekFrame(frameIndex - 1)}
              />
              <label>
                Frame{' '}
                <input
                  aria-label="Physics frame"
                  type="number"
                  min={call.trace_start}
                  max={call.trace_end - 1}
                  value={frameIndex}
                  disabled={world.busy}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isInteger(n)) seekFrame(n);
                  }}
                />
              </label>
              <IconButton
                icon="next"
                label="Next physics frame"
                disabled={world.busy || frameIndex === call.trace_end - 1}
                disabledReason={
                  world.busy
                    ? 'Wait for the active operation.'
                    : 'Already at the last recorded frame.'
                }
                onClick={() => seekFrame(frameIndex + 1)}
              />
              <span>
                {frame.phase} · step {frame.step} · {frame.sim_time.toFixed(6)} s
              </span>
            </div>
            <div className="physics-axis-row">
              <div
                ref={physics}
                className="physics-axis"
                role="slider"
                tabIndex={0}
                aria-label="Physics time"
                aria-valuemin={0}
                aria-valuemax={range.duration}
                aria-valuenow={
                  frame.phase === 'rollback' ? 0 : Math.max(0, frame.sim_time - range.origin)
                }
                aria-disabled={world.busy}
                {...physicsScrub}
                onKeyDown={(e) => {
                  const n =
                    e.key === 'Home'
                      ? call.trace_start
                      : e.key === 'End'
                        ? range.last
                        : e.key === 'ArrowLeft'
                          ? frameIndex - 1
                          : e.key === 'ArrowRight'
                            ? frameIndex + 1
                            : null;
                  if (n !== null) {
                    e.preventDefault();
                    seekFrame(n);
                  }
                }}
              >
                {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                  <span className="physics-tick" key={t} style={{ left: `${t * 100}%` }}>
                    {(range.duration * t).toFixed(3)} s
                  </span>
                ))}
                {frame.phase !== 'rollback' && (
                  <i className="physics-playhead" style={{ left: `${fraction * 100}%` }} />
                )}
              </div>
              {range.rollback !== null && (
                <IconButton
                  icon="undo"
                  label="Rollback"
                  description="Inspect the restored state after the failed attempt."
                  className="rollback-marker"
                  active={frame.phase === 'rollback'}
                  disabled={world.busy}
                  disabledReason="Wait for the active operation."
                  onClick={() => seekFrame(range.rollback!)}
                >
                  Rollback
                </IconButton>
              )}
            </div>
          </>
        ) : (
          <span className="timeline-no-physics">
            {call
              ? 'No recorded physics trajectory for this step.'
              : 'Initial state · select a step to inspect its trajectory.'}
          </span>
        )}
      </div>
    </div>
  );
}
