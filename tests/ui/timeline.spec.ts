import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import loadMujoco from '@mujoco/mujoco';
import { World } from '../../src/runtime';
import { decodeEpisode, encodeEpisode } from '../../src/archive';

let fixture: string, cameraFixture: string;
test.beforeAll(async ({}, info) => {
  World.engine = () => loadMujoco();
  const source = await decodeEpisode(
    new File(
      [new Uint8Array(await readFile(resolve('examples/two-objects.initial.episode.zip')))],
      'initial.zip',
    ),
  );
  const w = await World.create(source.assets, source);
  try {
    w.configure({
      ...w.config,
      physics: { ...w.config.physics, enabled: true, gravity: [0, 0, 0] },
    });
    await w.execute('advance_simulation', { duration: 2 }, 'webmcp');
    for (let i = 0; i < 5; i++) await w.execute('get_state', {}, 'webmcp');
    await w.execute('advance_simulation', { duration: 2 }, 'webmcp');
    w.cancelAtStep = 5;
    await w.execute('advance_simulation', { duration: 1 }, 'webmcp').catch(() => {});
    fixture = resolve(info.project.outputDir, 'timeline-fixture.zip');
    await mkdir(info.project.outputDir, { recursive: true });
    await writeFile(fixture, await encodeEpisode(w.episode));
    w.cancelAtStep = undefined;
    await w.execute('move_camera', { yaw: 45 }, 'webmcp');
    cameraFixture = resolve(info.project.outputDir, 'timeline-camera-fixture.zip');
    await writeFile(cameraFixture, await encodeEpisode(w.episode));
  } finally {
    w.dispose();
  }
});
async function open(page) {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Import OBJ', exact: true, includeHidden: true }),
  ).toBeEnabled();
  await page.getByLabel('Episode file', { exact: true }).setInputFiles(fixture);
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('8');
}

test('step timeline scrubs, zooms and keeps details explicitly controlled', async ({ page }) => {
  await open(page);
  const details = page.getByRole('complementary', { name: 'Call details' });
  const markers = page.getByRole('list', { name: 'Recorded calls' }).getByRole('listitem');
  await expect(details).toHaveCount(0);
  await markers.nth(1).click();
  await expect(details).toBeVisible();
  await expect(details).toContainText('get_state');
  await page.getByRole('button', { name: 'Hide call details' }).click();
  const axis = page.getByLabel('Step playhead', { exact: true });
  await axis.focus();
  await page.keyboard.press('Home');
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('0');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('1');
  await expect(details).toHaveCount(0);
  await markers.nth(2).click();
  await page.getByLabel('Current operation', { exact: true }).fill('4');
  await expect(details).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in timeline' }).click();
  const marker = await markers.nth(4).boundingBox();
  const box = await axis.boundingBox();
  await page.mouse.move(box!.x + 25, box!.y + 12);
  await page.mouse.down();
  await page.mouse.move(marker!.x + marker!.width / 2, box!.y + 12, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('5');
  await expect(page.getByRole('button', { name: 'Play history', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  const l = await page.locator('.timeline-tracks').boundingBox(),
    r = await details.boundingBox();
  expect(l!.width).toBeGreaterThan(r!.width * 1.7);
  await page.screenshot({ path: test.info().outputPath('timeline-wide.png') });
  await page.setViewportSize({ width: 1000, height: 760 });
  await expect
    .poll(async () => (await page.locator('.episode-timeline').boundingBox())!.width)
    .toBeLessThan(800);
  await page.waitForTimeout(150);
  await page.screenshot({ path: test.info().outputPath('timeline-narrow.png') });
  await page.getByRole('button', { name: 'Zoom in timeline' }).click();
  await page.getByRole('button', { name: 'Zoom in timeline' }).click();
  const scroller = page.locator('.timeline-tracks .timeline-scroll');
  await scroller.evaluate((el) => {
    el.scrollLeft = 100;
  });
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  page.on('dialog', (d) => d.accept());
  await page.getByLabel('Episode file', { exact: true }).setInputFiles(fixture);
  await expect(details).toHaveCount(0);
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(0);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeLessThanOrEqual(1);
});

for (const mode of ['calls', 'simulation'])
  test(`free camera stays continuous while ${mode} playback advances`, async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Go to initial state', exact: true }).click();
    await page.getByLabel('Playback mode', { exact: true }).selectOption(mode);
    // Start navigation from the recorded camera, which must transition without snapping.
    await page.getByRole('button', { name: 'Play history', exact: true }).click();
    const canvas = page.getByLabel('3D viewport', { exact: true }),
      box = (await canvas.boundingBox())!;
    const x = box.x + box.width * 0.5,
      y = box.y + box.height * 0.5;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 45, y + 20, { steps: 5 });
    const orientation = page.getByRole('button', { name: 'View from +X', exact: true });
    const moved = await orientation.getAttribute('style');
    // Hold the gesture across multiple cursor updates; a stale restore used to undo it.
    await page.waitForTimeout(1150);
    expect(await orientation.getAttribute('style')).toEqual(moved);
    await page.mouse.move(x + 80, y + 35, { steps: 4 });
    await expect(orientation).not.toHaveAttribute('style', moved!);
    await page.mouse.up();
    await expect(
      page.locator('.viewport-toolbar').getByRole('button', { name: 'Free View', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    const current = Number(
      await page.getByLabel('Current operation', { exact: true }).inputValue(),
    );
    expect(current).toBeGreaterThan(0);
    await page.mouse.move(x, y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(x + 25, y + 15, { steps: 5 });
    const panned = await canvas.screenshot();
    await page.waitForTimeout(350);
    expect(await canvas.screenshot()).toEqual(panned);
    await page.mouse.up({ button: 'right' });
    await page.mouse.wheel(0, 90);
    await page.waitForTimeout(150);
    const zoomed = await canvas.screenshot();
    await page.waitForTimeout(250);
    expect(await canvas.screenshot()).toEqual(zoomed);
    expect(zoomed.equals(panned)).toBe(false);
    await page.getByRole('button', { name: 'Pause playback', exact: true }).click();
  });

test('physical time seeks frames, resumes, and presents rollback separately', async ({ page }) => {
  await open(page);
  await page.getByLabel('Current operation', { exact: true }).fill('1');
  await expect(page.getByRole('complementary', { name: 'Call details' })).toHaveCount(0);
  const physicalAxis = await page.getByRole('slider', { name: 'Physics time' }).boundingBox();
  await page.mouse.click(physicalAxis!.x + physicalAxis!.width / 2, physicalAxis!.y + 10);
  await expect(page.getByLabel('Physics frame', { exact: true })).toHaveValue('500');
  await page.getByLabel('Physics frame', { exact: true }).fill('350');
  await expect(page.getByText(/physics · step 350/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('physics-timeline.png') });
  await page.getByRole('button', { name: 'Next physics frame' }).click();
  await expect(page.getByLabel('Physics frame', { exact: true })).toHaveValue('351');
  await page.getByLabel('Playback mode', { exact: true }).selectOption('simulation');
  await page.getByRole('button', { name: 'Play history', exact: true }).click();
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'Pause playback', exact: true }).click();
  const paused = Number(await page.getByLabel('Physics frame', { exact: true }).inputValue());
  expect(paused).toBeGreaterThan(351);
  await page.waitForTimeout(100);
  await expect(page.getByLabel('Physics frame', { exact: true })).toHaveValue(String(paused));
  await page.getByRole('button', { name: 'Play history', exact: true }).click();
  await expect
    .poll(async () => Number(await page.getByLabel('Physics frame', { exact: true }).inputValue()))
    .toBeGreaterThan(paused);
  await page.getByRole('button', { name: 'Pause playback', exact: true }).click();
  await page.getByLabel('Current operation', { exact: true }).fill('8');
  await expect(page.getByRole('button', { name: 'Rollback', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Previous physics frame' }).click();
  await expect(page.getByText(/physics · step 5/)).toBeVisible();
  await page.getByRole('button', { name: 'Rollback', exact: true }).click();
  await expect(page.getByText(/rollback · step 5/)).toBeVisible();
  await page.getByRole('button', { name: 'Timeline settings', exact: true }).click();
  await page.getByLabel('Include failed attempts').check();
  await page.keyboard.press('Escape');
  await page.getByLabel('Playback rate', { exact: true }).selectOption('8');
  await page.getByRole('button', { name: 'Play history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play history', exact: true })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('8');
  await expect(page.getByText(/rollback · step 5/)).toBeVisible();
});

test('call playback preserves intervals, resumes the last call and skips failed attempts by default', async ({
  page,
}) => {
  await open(page);
  const step = page.getByLabel('Current operation', { exact: true });
  await step.fill('2');
  await page.getByRole('button', { name: 'Play history', exact: true }).click();
  await expect(step).toHaveValue('3');
  await page.waitForTimeout(200);
  await expect(step).toHaveValue('3');
  await page.getByRole('button', { name: 'Pause playback', exact: true }).click();
  await step.fill('7');
  await page.getByRole('button', { name: 'Play history', exact: true }).click();
  await expect(step).toHaveValue('8');
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Pause playback', exact: true }).click();
  await page.getByRole('button', { name: 'Play history', exact: true }).click();
  await expect(step).toHaveValue('8');
  await expect(page.getByRole('button', { name: 'Play history', exact: true })).toBeVisible();
  await page.getByLabel('Playback mode', { exact: true }).selectOption('simulation');
  await page.getByRole('button', { name: 'Previous physics frame' }).click();
  await expect(page.getByText(/physics · step 5/)).toBeVisible();
  await page.getByRole('button', { name: 'Play history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play history', exact: true })).toBeVisible();
  await expect(page.getByText(/rollback · step 5/)).toBeVisible();
});

test('recorded camera follows the selected step while free view remains independent', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Import OBJ', exact: true, includeHidden: true }),
  ).toBeEnabled();
  await page.getByLabel('Episode file', { exact: true }).setInputFiles(cameraFixture);
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('9');
  const orientation = page.getByRole('button', { name: 'View from +X', exact: true });
  const endView = await orientation.getAttribute('style');
  await page.getByRole('button', { name: 'Go to initial state', exact: true }).click();
  await expect(orientation).not.toHaveAttribute('style', endView!);
  await page.getByLabel('Current operation', { exact: true }).fill('8');
  await page.getByRole('button', { name: 'Play history', exact: true }).click();
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('9');
  await expect(orientation).toHaveAttribute('style', endView!);
  await page.getByRole('button', { name: 'View from +X', exact: true }).click();
  await expect(orientation).not.toHaveAttribute('style', endView!);
  const free = await orientation.getAttribute('style');
  await page.getByRole('button', { name: 'Go to initial state', exact: true }).click();
  await expect(orientation).toHaveAttribute('style', free!);
});
