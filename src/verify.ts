import { World } from './runtime.ts';
import { asInitial, validateEpisode, hashes } from './archive.ts';
import type { Episode } from './types.ts';
export type VerificationReport = {
  status: 'passed' | 'diverged' | 'incompatible' | 'failed';
  mode: 'continuous' | 'operation';
  exact: boolean;
  atol: number;
  rtol: number;
  checked: number;
  coverage: string[];
  failureKind?:
    'invalid_archive' | 'incompatible' | 'capability' | 'execution' | 'semantic' | 'numerical';
  operations: {
    call: number;
    expectedSteps: number;
    actualSteps: number;
    expectedStop: unknown;
    actualStop: unknown;
  }[];
  firstExactDifference?: { call: number; path: string; expected: unknown; actual: unknown };
  firstDifference?: { call: number; path: string; expected: unknown; actual: unknown };
  maxAbsoluteError: number;
  maxErrors: Record<string, number>;
  error?: string;
};
export async function verifyEpisode(
  ep: Episode,
  options: { mode?: 'continuous' | 'operation'; atol?: number; rtol?: number } = {},
): Promise<VerificationReport> {
  const report: VerificationReport = {
    status: 'passed',
    mode: options.mode ?? 'continuous',
    exact: true,
    atol: options.atol ?? 0,
    rtol: options.rtol ?? 0,
    checked: 0,
    coverage: [
      'state',
      'commands',
      'observations:integrity-only',
      'scheduling-errors:context-only',
    ],
    maxAbsoluteError: 0,
    maxErrors: {},
    operations: [],
  };
  let world: World | undefined;
  const compare = (a: unknown, b: unknown, path: string, call: number): boolean => {
    if (typeof a === 'number' && typeof b === 'number') {
      const error = Math.abs(a - b);
      report.maxAbsoluteError = Math.max(report.maxAbsoluteError, error);
      if (a !== b) {
        report.exact = false;
        report.firstExactDifference ??= { call, path, expected: a, actual: b };
        const field = path.replace(/^trajectory\.\d+\./, '');
        report.maxErrors[field] = Math.max(report.maxErrors[field] ?? 0, error);
      }
      const discrete =
        /(^|\.)(steps|step|index|state_index|groupCounter|body|condim|type)(\.|$)/.test(path);
      if (
        Number.isFinite(error) &&
        error <= (discrete ? 0 : report.atol + report.rtol * Math.abs(a))
      )
        return true;
    } else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      return a.map((v, i) => compare(v, b[i], path + '.' + i, call)).every(Boolean);
    } else if (
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      const keys = Object.keys(a).sort();
      if (JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()))
        return keys
          .map((k) =>
            compare(
              (a as Record<string, unknown>)[k],
              (b as Record<string, unknown>)[k],
              path + '.' + k,
              call,
            ),
          )
          .every(Boolean);
    } else if (a === b) return true;
    report.exact = false;
    report.firstExactDifference ??= { call, path, expected: a ?? null, actual: b ?? null };
    report.firstDifference ??= { call, path, expected: a ?? null, actual: b ?? null };
    return false;
  };
  try {
    if (
      !Number.isFinite(report.atol) ||
      !Number.isFinite(report.rtol) ||
      report.atol < 0 ||
      report.rtol < 0
    )
      throw new Error('Tolerances must be finite and nonnegative.');
    validateEpisode(ep);
    for (const [key, hash] of Object.entries(await hashes(ep.observations)))
      if (key !== hash + '.png') throw new Error('Observation checksum mismatch.');
    for (const [key, hash] of Object.entries(await hashes(ep.assets))) {
      const expected = ep.manifest.hashes['world/' + key] ?? ep.manifest.hashes[key];
      if (expected && expected !== hash) throw new Error('World checksum mismatch.');
    }
    const initial = asInitial(ep);
    initial.manifest.id = ep.manifest.id;
    world = await World.create(initial.assets, initial);
    for (const c of ep.calls ?? []) {
      if (c.error_code === 'busy') {
        const request = ep.events.findIndex((e) => e.call_id === c.id && e.kind === 'request'),
          complete = ep.events.findIndex((e) => e.call_id === c.id && e.kind === 'complete');
        const overlapping = (ep.calls ?? []).some(
          (other) =>
            other.id !== c.id &&
            ep.events.findIndex((e) => e.call_id === other.id && e.kind === 'request') < request &&
            ep.events.findIndex((e) => e.call_id === other.id && e.kind === 'complete') > complete,
        );
        if (!overlapping || c.steps || c.trace_start !== c.trace_end)
          throw new Error('Invalid busy event context.');
      }
      if (c.name === 'capture_scene' || c.error_code === 'busy') {
        // Preserve provenance and call numbering without pretending to execute a capture/scheduler.
        world.episode.calls ??= [];
        world.episode.calls.push(structuredClone(c));
        continue;
      }
      if (report.mode === 'operation') {
        world.restoreLive(c.before_index ? ep.states[c.before_index - 1] : ep.initial);
        world.episode.states = structuredClone(ep.states.slice(0, c.before_index));
      }
      world.cancelAtStep = c.cancellation?.step;
      try {
        await world.executeRecorded(c.name, c.arguments, c.actor === 'agent' ? 'webmcp' : 'manual');
      } catch {
        /* Compare the recorded failure below. */
      }
      const actual = world.episode.calls?.at(-1);
      if (!actual || actual.id !== c.id) {
        report.status = 'failed';
        report.error = 'Missing replay call';
        break;
      }
      const expectedTrace = ep.trajectory.slice(c.trace_start, c.trace_end),
        actualTrace = world.episode.trajectory.slice(actual.trace_start, actual.trace_end);
      const comparable = (f: Episode['trajectory'][number]) => ({
        integration: f.integration,
        camera: f.camera,
        groups: f.groups,
        groupCounter: f.groupCounter,
        phase: f.phase,
        step: f.step,
        sim_time: f.sim_time,
        ...(f.applied ? { applied: f.applied } : {}),
      });
      let ok = compare(
        expectedTrace.map(comparable),
        actualTrace.map(comparable),
        'trajectory',
        c.index,
      );
      for (const key of ['status', 'error_code', 'steps', 'sim_end', 'state_index'] as const)
        ok = compare(c[key], actual[key], key, c.index) && ok;
      if (c.status === 'completed') ok = compare(c.result, actual.result, 'result', c.index) && ok;
      const stop = (result: unknown) =>
        (result as { physics?: string } | undefined)?.physics ?? null;
      report.operations.push({
        call: c.index,
        expectedSteps: c.steps,
        actualSteps: actual.steps,
        expectedStop: c.error_code ?? stop(c.result),
        actualStop: actual.error_code ?? stop(actual.result),
      });
      report.checked++;
      if (!ok) {
        report.status = 'diverged';
        report.failureKind =
          typeof report.firstDifference?.expected === 'number' &&
          typeof report.firstDifference.actual === 'number'
            ? 'numerical'
            : 'semantic';
        break;
      }
    }
  } catch (e) {
    report.status = /contract|layout|Unsupported|capability/i.test(String(e))
      ? 'incompatible'
      : 'failed';
    report.error = String(e);
    report.failureKind = /capability/i.test(String(e))
      ? 'capability'
      : report.status === 'incompatible'
        ? 'incompatible'
        : /schema|checksum|observation|frame|event|archive/i.test(String(e))
          ? 'invalid_archive'
          : 'execution';
  } finally {
    world?.dispose();
  }
  return report;
}
