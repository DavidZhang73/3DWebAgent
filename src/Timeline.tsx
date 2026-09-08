import { useEffect, useRef, useState } from 'react';
import { IconButton, IconPopover } from './EditorControls';
import { TimelineTracks } from './TimelineTracks';
import type { World } from './runtime';
import { verifyEpisode } from './verify';
import type { VerificationReport } from './verify';

export function Timeline({ world }: { world: World }) {
  const [selected, setSelected] = useState(-1),
    [detailOpen, setDetailOpen] = useState(false),
    [includeFailed, setIncludeFailed] = useState(false),
    [playing, setPlaying] = useState(false),
    [rate, setRate] = useState(1),
    [mode, setMode] = useState<'calls' | 'simulation'>('calls');
  const [report, setReport] = useState<VerificationReport>(),
    [verifying, setVerifying] = useState(false),
    [url, setUrl] = useState('');
  const calls = world.episode.calls ?? [],
    call = calls[selected],
    trace = world.episode.trajectory;
  const elapsed = useRef(0);
  const finished = useRef(false);
  const navigation = useRef(0);
  const fail = (e: unknown) => {
    world.error = String(e);
    world.notify();
  };
  const select = (i: number) => {
    if (world.busy) return;
    navigation.current++;
    setSelected(i);
    elapsed.current = 0;
    finished.current = false;
    world.setCursor(i < 0 ? (world.recording ? 0 : null) : calls[i].state_index);
  };
  useEffect(() => {
    if (world.cursor === null) setSelected(calls.length - 1);
  }, [calls.length, world.cursor]);
  useEffect(() => {
    setSelected((world.episode.calls?.length ?? 0) - 1);
    setDetailOpen(false);
    elapsed.current = 0;
    finished.current = false;
    setPlaying(false);
    setReport(undefined);
  }, [world]);
  useEffect(() => {
    const result = call?.result as { content?: { observation?: string }[] } | undefined;
    const key = result?.content?.find((c) => c.observation)?.observation,
      bytes = key ? world.episode.observations[key] : undefined;
    const next = bytes
      ? URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: 'image/png' }))
      : '';
    setUrl(next);
    return () => {
      if (next) URL.revokeObjectURL(next);
    };
  }, [world, call]);
  useEffect(() => {
    setPlaying(false);
  }, [world.busy, calls.length]);
  useEffect(() => {
    if (!playing || world.busy || !calls.length) return;
    let token = 0;
    const next = () => {
      if (world.busy) {
        setPlaying(false);
        return;
      }
      elapsed.current = 0;
      if (selected + 1 >= calls.length) {
        finished.current = true;
        setPlaying(false);
      } else select(selected + 1);
    };
    if (
      mode === 'calls' ||
      selected < 0 ||
      !call ||
      call.trace_start === call.trace_end ||
      (call.status === 'error' && !includeFailed)
    ) {
      if (
        world.traceCursor !== null &&
        (mode === 'calls' || (call?.status === 'error' && !includeFailed))
      )
        world.setCursor(call.state_index);
      const duration = mode === 'calls' ? 1000 : 150;
      const start = performance.now(),
        generation = navigation.current;
      const timer = setTimeout(next, Math.max(0, duration - elapsed.current) / rate);
      return () => {
        clearTimeout(timer);
        if (navigation.current === generation)
          elapsed.current += (performance.now() - start) * rate;
      };
    }
    const end = call.trace_end;
    let index =
      world.traceCursor !== null && world.traceCursor >= call.trace_start && world.traceCursor < end
        ? world.traceCursor
        : call.trace_start;
    world.setTraceCursor(index);
    const startTime = trace[index].sim_time,
      start = performance.now();
    let completeAt: number | null = null;
    const tick = () => {
      if (world.busy) {
        setPlaying(false);
        return;
      }
      const target = startTime + ((performance.now() - start) * rate) / 1000;
      while (
        index + 1 < end &&
        trace[index + 1].sim_time >= trace[index].sim_time &&
        trace[index + 1].sim_time <= target
      )
        index++;
      if (index + 1 < end && trace[index + 1].sim_time < trace[index].sim_time) index++;
      if (world.traceCursor !== index) world.setTraceCursor(index);
      if (index + 1 >= end) {
        // Keep the final / rollback endpoint visible before advancing to the next call.
        completeAt ??= performance.now();
        if ((performance.now() - completeAt) * rate >= 150) {
          next();
          return;
        }
      }
      token = requestAnimationFrame(tick);
    };
    token = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(token);
  }, [playing, mode, selected, rate, world, world.busy, includeFailed, calls.length]);

  const togglePlayback = () => {
    if (world.busy || !calls.length) return;
    if (
      !playing &&
      (finished.current ||
        (selected === calls.length - 1 &&
          ((mode === 'calls' && elapsed.current === 0) ||
            (mode === 'simulation' && world.traceCursor === null) ||
            world.traceCursor === call?.trace_end - 1)))
    )
      select(-1);
    setPlaying((p) => !p);
  };
  useEffect(() => {
    world.playback = togglePlayback;
    return () => {
      world.playback = undefined;
    };
  });
  const verify = async () => {
    setVerifying(true);
    try {
      setReport(await verifyEpisode(world.episode));
    } catch (e) {
      fail(e);
    } finally {
      setVerifying(false);
    }
  };
  const exportReport = () => {
    if (!report) return;
    const u = URL.createObjectURL(
        new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
      ),
      a = document.createElement('a');
    a.href = u;
    a.download = 'episode-verification.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  };
  const lifecycle = world.episode.manifest.lifecycle;
  return (
    <section
      className="episode-timeline"
      aria-label="Operation timeline"
      data-shortcuts="timeline"
      tabIndex={0}
    >
      <div className="timeline-toolbar">
        <span
          className={'episode-status ' + lifecycle}
          data-tooltip="Episode status"
          data-description={
            lifecycle === 'setup'
              ? 'Initial scene editing is available.'
              : 'Calls are recorded in this episode.'
          }
          aria-label={'Episode · ' + lifecycle}
        >
          {lifecycle}
        </span>
        <IconButton
          icon="record"
          label="Start episode"
          description="Freeze the initial scene and begin recording calls. This does not start playback."
          disabled={world.busy || lifecycle !== 'setup'}
          disabledReason={
            world.busy ? 'Wait for the active operation.' : 'This episode has already started.'
          }
          onClick={() => void world.execute('start_episode', {}).catch(fail)}
        />
        <span className="toolbar-divider" />
        <div className="control-group" role="group" aria-label="Playback navigation">
          <IconButton
            icon="first"
            label="Go to initial state"
            description="Show the initial state, before all calls."
            disabled={world.busy}
            disabledReason="Wait for the active operation."
            onClick={() => {
              setPlaying(false);
              select(-1);
            }}
          />
          <IconButton
            icon="previous"
            label="Previous step"
            description="Pause and inspect the previous call."
            disabled={world.busy || selected < 0}
            disabledReason={
              world.busy ? 'Wait for the active operation.' : 'Already at the initial state.'
            }
            onClick={() => {
              setPlaying(false);
              select(selected - 1);
            }}
          />
          <IconButton
            icon={playing ? 'pause' : 'play'}
            label={playing ? 'Pause playback' : 'Play history'}
            description="Replay recorded calls and physics without changing the episode."
            shortcut="Space"
            active={playing}
            disabled={world.busy || !calls.length}
            disabledReason={
              world.busy ? 'Wait for the active operation.' : 'No recorded calls to play.'
            }
            onClick={togglePlayback}
          />
          <IconButton
            icon="next"
            label="Next step"
            description="Pause and inspect the next call."
            disabled={world.busy || selected + 1 >= calls.length}
            disabledReason={
              world.busy ? 'Wait for the active operation.' : 'Already at the last call.'
            }
            onClick={() => {
              setPlaying(false);
              select(selected + 1);
            }}
          />
          <IconButton
            icon="last"
            label="Return to latest"
            description="Leave history and return to the live scene."
            disabled={world.busy}
            disabledReason="Wait for the active operation."
            onClick={() => {
              setPlaying(false);
              navigation.current++;
              elapsed.current = 0;
              finished.current = false;
              world.setCursor(null);
            }}
          />
        </div>
        <label>
          Call{' '}
          <input
            aria-label="Current operation"
            type="number"
            min={0}
            max={calls.length}
            value={selected + 1}
            disabled={world.busy}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 0 && n <= calls.length) {
                setPlaying(false);
                select(n - 1);
              }
            }}
          />
        </label>
        <select
          aria-label="Playback mode"
          value={mode}
          onChange={(e) => {
            setPlaying(false);
            elapsed.current = 0;
            setMode(e.target.value as typeof mode);
          }}
        >
          <option value="calls">Calls</option>
          <option value="simulation">Physics</option>
        </select>
        <select
          aria-label="Playback rate"
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
        >
          {[0.25, 1, 2, 4, 8].map((r) => (
            <option key={r} value={r}>
              {r}×
            </option>
          ))}
        </select>
        <IconPopover icon="settings" label="Timeline settings">
          <label className="check">
            <input
              type="checkbox"
              checked={includeFailed}
              onChange={(e) => {
                setPlaying(false);
                setIncludeFailed(e.target.checked);
              }}
            />
            Include failed attempts
          </label>
          <button disabled={verifying || world.busy || !calls.length} onClick={() => void verify()}>
            Verify actions
          </button>
        </IconPopover>
        {verifying && (
          <span role="status" className="verification-state">
            Verifying…
          </span>
        )}
      </div>
      <div className={`episode-columns ${detailOpen ? 'with-detail' : ''}`}>
        <TimelineTracks
          world={world}
          selected={selected}
          playing={playing}
          select={select}
          pause={() => {
            navigation.current++;
            elapsed.current = 0;
            finished.current = false;
            setPlaying(false);
          }}
          inspect={() => setDetailOpen(true)}
        />
        {detailOpen && (
          <aside className="episode-detail" aria-label="Call details">
            <IconButton
              icon="close"
              label="Hide call details"
              className="close-call-detail"
              onClick={() => setDetailOpen(false)}
            />
            {call ? (
              <>
                <strong>
                  {call.name} · {call.status}
                </strong>
                <pre>
                  {JSON.stringify(
                    {
                      arguments: call.arguments,
                      ...(call.status === 'error'
                        ? {
                            error: call.error,
                            code: call.error_code,
                            cancellation: call.cancellation,
                          }
                        : { result: call.result }),
                    },
                    null,
                    2,
                  )}
                </pre>
                {url && (
                  <figure>
                    <figcaption>Original agent observation</figcaption>
                    <img src={url} alt="Original agent observation" />
                  </figure>
                )}
              </>
            ) : (
              <p>
                {trace.length} recorded trajectory frames · {world.episode.states.length} committed
                states. Free View never changes agent observations.
              </p>
            )}
          </aside>
        )}
      </div>
      {report && (
        <details className="timeline-verification" open>
          <summary>Verification: {report.status}</summary>
          <pre>{JSON.stringify(report, null, 2)}</pre>
          <button onClick={exportReport}>Export verification report</button>
        </details>
      )}
    </section>
  );
}
