import { useEffect, useRef, useState } from 'react';
import type { World } from './runtime';
import { verifyEpisode } from './verify';
import type { VerificationReport } from './verify';

export function Timeline({ world }: { world: World }) {
  const [selected, setSelected] = useState(-1),
    [expanded, setExpanded] = useState(false),
    [playing, setPlaying] = useState(false),
    [rate, setRate] = useState(1),
    [mode, setMode] = useState<'calls' | 'simulation'>('calls');
  const [report, setReport] = useState<VerificationReport>(),
    [verifying, setVerifying] = useState(false),
    [url, setUrl] = useState('');
  const calls = world.episode.calls ?? [],
    call = calls[selected],
    trace = world.episode.trajectory;
  const playRef = useRef({ start: 0, index: 0 });
  const fail = (e: unknown) => {
    world.error = String(e);
    world.notify();
  };
  const select = (i: number) => {
    setSelected(i);
    setExpanded(false);
    world.setCursor(i < 0 ? (world.recording ? 0 : null) : calls[i].state_index);
  };
  useEffect(() => {
    if (world.cursor === null) setSelected(calls.length - 1);
  }, [calls.length, world.cursor]);
  useEffect(() => {
    setSelected((world.episode.calls?.length ?? 0) - 1);
    setExpanded(false);
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
    if (!playing || world.busy) return;
    if (mode === 'calls') {
      const timer = setTimeout(() => {
        if (selected + 1 >= calls.length) setPlaying(false);
        else select(selected + 1);
      }, 1000 / rate);
      return () => clearTimeout(timer);
    }
    if (selected < 0) {
      select(0);
      return;
    }
    const next = () => {
      if (selected + 1 >= calls.length) setPlaying(false);
      else select(selected + 1);
    };
    const start = call?.trace_start ?? 0,
      end = call?.trace_end ?? 0;
    // Give zero-duration calls an ordered display interval. Failed attempts are opt-in.
    if (start === end || (call?.status === 'error' && !expanded)) {
      const timer = setTimeout(next, 150 / rate);
      return () => clearTimeout(timer);
    }
    world.setTraceCursor(start);
    playRef.current = { start: performance.now(), index: start };
    let token = 0;
    const tick = () => {
      if (world.busy) {
        setPlaying(false);
        return;
      }
      const p = playRef.current,
        target = trace[start].sim_time + ((performance.now() - p.start) * rate) / 1000;
      while (
        p.index + 1 < end &&
        trace[p.index + 1].sim_time >= trace[p.index].sim_time &&
        trace[p.index + 1].sim_time <= target
      )
        p.index++;
      world.setTraceCursor(p.index);
      if (p.index + 1 >= end) next();
      else if (trace[p.index + 1].sim_time < trace[p.index].sim_time) {
        world.setTraceCursor(p.index + 1);
        next();
      } else token = requestAnimationFrame(tick);
    };
    token = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(token);
  }, [playing, mode, selected, rate, world, world.busy, expanded]);

  useEffect(() => {
    world.playback = () => setPlaying((p) => !p);
    return () => {
      world.playback = undefined;
    };
  }, [world]);
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
        <strong>Episode · {lifecycle}</strong>
        <button
          disabled={world.busy || lifecycle !== 'setup'}
          onClick={() => void world.execute('start_episode', {}).catch(fail)}
        >
          Start episode
        </button>
        <button
          disabled={world.busy || lifecycle !== 'active'}
          onClick={() => void world.execute('end_episode', { reason: 'user_stop' }).catch(fail)}
        >
          End episode
        </button>
        <button
          disabled={world.busy}
          aria-label="Go to initial state"
          onClick={() => {
            setPlaying(false);
            select(-1);
          }}
        >
          Initial
        </button>
        <button
          disabled={world.busy || !calls.length}
          aria-label={playing ? 'Pause playback' : 'Play history'}
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
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
        <button
          disabled={world.busy}
          aria-label="Return to latest"
          onClick={() => {
            setPlaying(false);
            world.setCursor(null);
          }}
        >
          Latest
        </button>
        <select
          aria-label="Playback mode"
          value={mode}
          onChange={(e) => {
            setPlaying(false);
            setMode(e.target.value as typeof mode);
          }}
        >
          <option value="calls">By call</option>
          <option value="simulation">Simulation time</option>
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
        <button disabled={verifying || world.busy || !calls.length} onClick={() => void verify()}>
          {verifying ? 'Verifying…' : 'Verify actions'}
        </button>
      </div>
      <div className="episode-columns">
        <div className="episode-calls" role="list" aria-label="Recorded calls">
          {calls.map((c, i) => (
            <button
              key={c.id}
              role="listitem"
              aria-current={i === selected ? 'step' : undefined}
              disabled={world.busy}
              onClick={() => {
                setPlaying(false);
                select(i);
              }}
            >
              <span>
                {i + 1} · {c.actor} · {c.name}
              </span>
              <small>
                {c.status === 'error'
                  ? c.error_code
                  : `${c.steps} physics steps · ${(c.sim_end - c.sim_start).toFixed(3)} s`}
              </small>
            </button>
          ))}
          {!calls.length && <p>Setup editor · the first agent call starts recording.</p>}
        </div>
        <div className="episode-detail">
          {call ? (
            <>
              <strong>
                {call.name} · {call.status}
              </strong>
              {call.trace_end > call.trace_start && (
                <>
                  <button
                    aria-expanded={expanded}
                    onClick={() => {
                      setPlaying(false);
                      setExpanded((v) => !v);
                    }}
                  >
                    {expanded ? 'Hide' : 'Inspect'}{' '}
                    {call.status === 'error' ? 'attempt and rollback' : 'physics trajectory'} (
                    {call.trace_end - call.trace_start} frames)
                  </button>
                  {expanded && (
                    <>
                      <p>
                        {world.traceCursor !== null
                          ? `${trace[world.traceCursor].phase} · step ${trace[world.traceCursor].step} · ${trace[world.traceCursor].sim_time.toFixed(6)} s`
                          : 'Select a recorded frame'}
                      </p>
                      <input
                        aria-label="Physics frame"
                        type="range"
                        min={call.trace_start}
                        max={call.trace_end - 1}
                        value={world.traceCursor ?? call.trace_start}
                        onChange={(e) => {
                          setPlaying(false);
                          world.setTraceCursor(Number(e.target.value));
                        }}
                      />
                    </>
                  )}
                </>
              )}
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
          {report && (
            <div role="status">
              <strong>Verification: {report.status}</strong>
              <pre>{JSON.stringify(report, null, 2)}</pre>
              <button onClick={exportReport}>Export verification report</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
