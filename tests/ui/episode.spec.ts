import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { decodeEpisode } from '../../src/archive';

async function installTools(page) {
  await page.addInitScript(() => {
    const tools = new Map();
    (globalThis as any).__episodeTools = tools;
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool(tool, options) {
          tools.set(tool.name, tool);
          options.signal.addEventListener('abort', () => tools.delete(tool.name));
        },
        unregisterTool(name) {
          tools.delete(name);
        },
        getTools: async () => [...tools.values()].map((t) => ({ name: t.name })),
      },
    });
  });
}
const invoke = (page, name, args = {}) =>
  page.evaluate(
    async ({ name, args }) =>
      JSON.parse(await (globalThis as any).__episodeTools.get(name).execute(args)),
    { name, args },
  );

test('agent capture is independent of free view, theme, viewport size and a closed viewport', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installTools(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Import OBJ', exact: true })).toBeEnabled();
  await page
    .getByLabel('Episode file', { exact: true })
    .setInputFiles(resolve('examples/two-objects.initial.episode.zip'));
  await expect(page.locator('[data-object-id]')).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).__episodeTools.has('capture_scene')))
    .toBe(true);
  const first = await invoke(page, 'capture_scene');
  expect(first.content[0].type).toBe('image');
  expect(first.render).toMatchObject({ width: 1024, height: 768 });
  expect(Buffer.from(first.content[0].data, 'base64').readUInt32BE(16)).toBe(1024);
  await page.getByText('Theme', { exact: true }).click();
  await page.getByRole('button', { name: 'Latte', exact: true }).click();
  await page.getByRole('button', { name: 'View from +X', exact: true }).click();
  await page.setViewportSize({ width: 1250, height: 800 });
  const second = await invoke(page, 'capture_scene');
  expect(second.content[0].data).toEqual(first.content[0].data);
  // Dockview's close action disposes the visible Viewer, not the world capture service.
  const viewportTab = page.locator('.dv-tab').filter({ hasText: 'Viewport' });
  await viewportTab.locator('.dv-default-tab-action').click();
  await expect(page.getByLabel('Interactive 3D scene', { exact: true })).toHaveCount(0);
  const third = await invoke(page, 'capture_scene');
  expect(third.content[0].data).toEqual(first.content[0].data);
  await expect(
    page.getByRole('list', { name: 'Recorded calls' }).getByRole('listitem'),
  ).toHaveCount(3);
  await page.getByRole('list', { name: 'Recorded calls' }).getByRole('listitem').first().click();
  await expect(page.getByAltText('Original agent observation')).toBeVisible();
  const promise = page.waitForEvent('download');
  await page.getByText('File', { exact: true }).click();
  await page.getByRole('button', { name: 'Export full episode…', exact: true }).click();
  const download = await promise;
  const path = test.info().outputPath('captured.episode.zip');
  await download.saveAs(path);
  const ep = await decodeEpisode(new File([new Uint8Array(await readFile(path))], 'captured.zip'));
  expect(Object.keys(ep.observations)).toHaveLength(1);
  expect(ep.calls).toHaveLength(3);
  expect(JSON.parse(ep.calls![0].transport!).content[0].data).toEqual(first.content[0].data);
  const native = JSON.parse(
    execFileSync(
      process.env.EPISODE_PYTHON ?? 'python/.venv/bin/python',
      ['python/replay.py', 'verify', path],
      { encoding: 'utf8' },
    ),
  );
  expect(native.status).toBe('passed');
  expect(native.checked).toBe(0);
  expect(native.coverage).toContain('observations:integrity-only');
  expect(errors).toEqual([]);
});

test('physics frames are inspectable and verification reports the original recorded run', async ({
  page,
}) => {
  await installTools(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Import OBJ', exact: true })).toBeEnabled();
  await page
    .getByLabel('Episode file', { exact: true })
    .setInputFiles(resolve('examples/two-objects.initial.episode.zip'));
  await expect(page.locator('[data-object-id]')).toHaveCount(2);
  await page.getByText('View', { exact: true }).click();
  await page.getByRole('button', { name: 'World', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Enable physics', exact: true }).check();
  const result = await invoke(page, 'advance_simulation', { duration: 0.02 });
  expect(result.steps).toBe(10);
  await page.getByRole('list', { name: 'Recorded calls' }).getByRole('listitem').first().click();
  await page.getByRole('button', { name: /Inspect physics trajectory/ }).click();
  const slider = page.getByRole('slider', { name: 'Physics frame' });
  await slider.fill('5');
  await expect(page.getByText(/physics · step 5/)).toBeVisible();
  await page.getByRole('button', { name: 'Verify actions', exact: true }).click();
  await expect(page.getByText('Verification: passed', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('episode-physics-replay.png') });
  await page.getByRole('button', { name: 'Return to latest', exact: true }).click();
  await page.getByRole('button', { name: 'End episode', exact: true }).click();
  await expect(page.getByText('Episode · ended', { exact: true })).toBeVisible();
});

test('a native continuation opens in the browser with human interventions and original physics frames', async ({
  page,
}) => {
  await installTools(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Import OBJ', exact: true })).toBeEnabled();
  const path = resolve('examples/portable-physics.episode.zip');
  const ep = await decodeEpisode(new File([new Uint8Array(await readFile(path))], 'portable.zip'));
  await page.getByLabel('Episode file', { exact: true }).setInputFiles(path);
  const calls = page.getByRole('list', { name: 'Recorded calls' }).getByRole('listitem');
  await expect(calls).toHaveCount(ep.calls!.length);
  const intervention = ep.calls!.find(
    (c) => c.actor === 'human' && c.producer.backend === 'native',
  )!;
  await calls.nth(intervention.index).click();
  await page.getByRole('button', { name: /Inspect physics trajectory/ }).click();
  await page
    .getByRole('slider', { name: 'Physics frame' })
    .fill(String(intervention.trace_start + 5));
  await expect(page.getByText(/physics · step 5/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('portable-human-intervention.png') });
  expect((await invoke(page, 'advance_simulation', { duration: 0.002 })).steps).toBe(1);
  await expect(page.getByText(/physics · step 5/)).toBeVisible();
  await page.getByRole('button', { name: 'Return to latest', exact: true }).click();
  await expect(calls).toHaveCount(ep.calls!.length + 1);
  await page.getByRole('button', { name: 'Go to initial state', exact: true }).click();
  await page.getByLabel('Playback mode', { exact: true }).selectOption('simulation');
  await page.getByRole('button', { name: 'Play history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play history', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue(
    String(ep.calls!.length + 1),
  );
});

test('a browser 30000-step episode exports, restores and locates its middle frame', async ({
  page,
}) => {
  test.setTimeout(60000);
  await installTools(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Import OBJ', exact: true })).toBeEnabled();
  await page
    .getByLabel('Episode file', { exact: true })
    .setInputFiles(resolve('examples/two-objects.initial.episode.zip'));
  await expect(page.locator('[data-object-id]')).toHaveCount(2);
  await page.getByText('View', { exact: true }).click();
  await page.getByRole('button', { name: 'World', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Enable physics', exact: true }).check();
  expect((await invoke(page, 'advance_simulation', { duration: 60 })).steps).toBe(30000);
  const pending = page.waitForEvent('download');
  await page.getByText('File', { exact: true }).click();
  await page.getByRole('button', { name: 'Export full episode…', exact: true }).click();
  const download = await pending;
  const path = test.info().outputPath('30000-steps.episode.zip');
  await download.saveAs(path);
  const ep = await decodeEpisode(new File([new Uint8Array(await readFile(path))], 'long.zip'));
  expect(ep.trajectory.filter((f) => f.phase === 'physics')).toHaveLength(30000);
  const native = JSON.parse(
    execFileSync(
      process.env.EPISODE_PYTHON ?? 'python/.venv/bin/python',
      ['python/replay.py', 'inspect', path],
      { encoding: 'utf8' },
    ),
  );
  expect(native.max_restore_error).toBe(0);
  expect(native.physics_frames).toBe(30000);
  page.on('dialog', (d) => d.accept());
  await page.getByLabel('Episode file', { exact: true }).setInputFiles(path);
  await page.getByRole('list', { name: 'Recorded calls' }).getByRole('listitem').first().click();
  await page.getByRole('button', { name: /Inspect physics trajectory/ }).click();
  await page.getByRole('slider', { name: 'Physics frame' }).fill('15000');
  await expect(page.getByText(/physics · step 15000 · 30.000000 s/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('30000-steps-middle.png') });
});
