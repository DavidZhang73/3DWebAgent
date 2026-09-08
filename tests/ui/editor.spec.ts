import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';

// Exercise the real registration callbacks without depending on an experimental browser flag.
async function start(page: Page) {
  await page.addInitScript(() => {
    const tools: Record<string, any> = {};
    (window as any).__testTools = tools;
    Object.defineProperty(document, 'modelContext', {
      value: {
        registerTool: (tool: any) => {
          tools[tool.name] = tool;
        },
        unregisterTool: (name: string) => {
          delete tools[name];
        },
        getTools: async () => Object.values(tools),
      },
    });
  });
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Import OBJ', exact: true, includeHidden: true }),
  ).toBeEnabled();
}
async function call(page: Page, name: string, args: Record<string, unknown> = {}) {
  await expect
    .poll(() => page.evaluate((name) => !!(window as any).__testTools[name], name))
    .toBe(true);
  return page.evaluate(
    async ({ name, args }) => JSON.parse(await (window as any).__testTools[name].execute(args)),
    { name, args },
  );
}
async function panel(page: Page, name: string) {
  await page.getByText('View', { exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
}
async function change(page: Page, name: string, value: string) {
  const field = page.getByRole('spinbutton', { name, exact: true });
  await field.fill(value);
  await field.press('Enter');
}
async function exported(page: Page, initial = false) {
  const next = page.waitForEvent('download');
  await page.getByText('File', { exact: true }).click();
  await page
    .getByRole('button', {
      name: initial ? 'Export current as initial…' : 'Export full episode…',
      exact: true,
    })
    .click();
  const download = await next;
  return { download, files: unzipSync(await readFile((await download.path())!)) };
}
const json = (files: Record<string, Uint8Array>, name: string) =>
  JSON.parse(new TextDecoder().decode(files[name]));

test('object editing, structural undo and savepoints preserve IDs and call logs', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page);
  await page
    .getByLabel('OBJ files', { exact: true })
    .setInputFiles(resolve('tests/fixtures/split-parts.obj'));
  const rows = page.locator('[data-object-id]');
  await expect(rows).toHaveCount(2);
  const ids = await rows.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-object-id')),
  );
  await rows.first().dblclick();
  await page.getByLabel('Rename', { exact: true }).fill('Named Part');
  await page.getByLabel('Rename', { exact: true }).press('Enter');
  await expect(page.getByLabel('Object name', { exact: true })).toHaveValue('Named Part');
  await page.getByRole('tab', { name: 'Physics properties', exact: true }).click();
  await change(page, 'Mass', '2');
  await expect(page.getByLabel('Mass', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('Mass', { exact: true })).toHaveValue('2');
  await rows.first().focus();
  await page.keyboard.press('Control+z');
  await expect(page.getByLabel('Mass', { exact: true })).toHaveValue('1');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByLabel('Mass', { exact: true })).toHaveValue('2');
  await exported(page);
  await expect(page.locator('.window-title')).not.toContainText('•');
  await page.getByRole('tab', { name: 'Object properties', exact: true }).click();
  await change(page, 'Position X', '1.5');
  await rows.first().focus();
  await page.keyboard.press('Control+z');
  await expect(page.locator('.window-title')).not.toContainText('•');
  await rows.first().click();
  await rows.nth(1).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+g');
  await expect(page.locator('.group-row')).toHaveCount(1);
  await page.locator('.group-row').click();
  await page.keyboard.press('F2');
  await page.getByLabel('Rename', { exact: true }).fill('Pair');
  await page.getByLabel('Rename', { exact: true }).press('Enter');
  await expect(page.locator('.group-row')).toContainText('Pair');
  await page.locator('.group-row').focus();
  await page.keyboard.press('Delete');
  await expect(rows).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('.group-row')).toContainText('Pair');
  expect(
    await rows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-object-id'))),
  ).toEqual(ids);
  await call(page, 'list_objects');
  await call(page, 'get_state');
  const full = await exported(page);
  const calls = new TextDecoder().decode(full.files['calls.jsonl']).split('\n').map(JSON.parse);
  expect(calls.map((c: any) => c.name)).toEqual(['list_objects', 'get_state']);
  expect(errors).toEqual([]);
});

test('inferred inertia, friction and collision edits survive export and invalid values roll back', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page);
  await page
    .getByLabel('Episode file', { exact: true })
    .setInputFiles(resolve('examples/two-objects.initial.episode.zip'));
  const rows = page.locator('[data-object-id]');
  await expect(rows).toHaveCount(2);
  await rows.first().click();
  const id = await rows.first().getAttribute('data-object-id');
  await page.getByRole('tab', { name: 'Physics properties', exact: true }).click();
  await change(page, 'Mass', '3');
  await expect(page.getByLabel('Mass', { exact: true })).toHaveValue('3');
  await change(page, 'Sliding friction', '0.4');
  await expect(page.getByLabel('Sliding friction', { exact: true })).toHaveValue('0.4');
  await page.getByLabel('Object collision', { exact: true }).uncheck();
  await expect(page.getByLabel('Object collision', { exact: true })).not.toBeChecked();
  await change(page, 'Mass', '-1');
  await expect(page.locator('.status-error')).toContainText('positive');
  const after = await call(page, 'get_object', { id });
  expect(after.mass).toBe(3);
  after.inertia.forEach((v: number) => expect(v).toBeCloseTo(0.012, 10));
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  const result = await exported(page, true);
  await result.download.saveAs(info.outputPath('physics.episode.zip'));
  page.on('dialog', (d) => d.accept());
  const manifest = json(result.files, 'manifest.json');
  expect(manifest.objects.find((o: any) => o.id === id).collisionEnabled).toBe(false);
  await page
    .getByLabel('Episode file', { exact: true })
    .setInputFiles(info.outputPath('physics.episode.zip'));
  await page.locator(`[data-object-id="${id}"]`).click();
  await expect(page.getByLabel('Mass', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('Sliding friction', { exact: true })).toHaveValue('0.4');
  await expect(page.getByLabel('Object collision', { exact: true })).not.toBeChecked();
  await page.getByLabel('Object collision', { exact: true }).check();
  await expect(page.getByLabel('Object collision', { exact: true })).toBeChecked();
  expect(errors).toEqual([]);
});

test('modal multi-object transforms commit once, cancel exactly and ignore text input', async ({
  page,
}) => {
  await start(page);
  await page
    .getByLabel('Episode file', { exact: true })
    .setInputFiles(resolve('examples/two-objects.initial.episode.zip'));
  const rows = page.locator('[data-object-id]');
  await expect(rows).toHaveCount(2);
  await rows.first().click();
  await rows.nth(1).click({ modifiers: ['Shift'] });
  const before = await call(page, 'get_state'),
    canvas = page.getByLabel('3D viewport', { exact: true }),
    box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await canvas.focus();
  const count = await page.getByRole('listitem').count();
  await page.keyboard.press('g');
  await expect(page.locator('.status-hint')).toContainText('Confirm');
  await page.keyboard.press('x');
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
  await page.keyboard.press('Escape');
  expect((await call(page, 'get_state')).objects).toEqual(before.objects);
  await expect(
    page.getByRole('list', { name: 'Recorded calls' }).getByRole('listitem'),
  ).toHaveCount(count + 1);
  await page.keyboard.press('g');
  await expect(page.locator('.status-hint')).toContainText('Confirm');
  await page.keyboard.press('x');
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('list', { name: 'Recorded calls' }).getByRole('listitem'),
  ).toHaveCount(count + 2);
  const moved = await call(page, 'get_state');
  const delta = moved.objects[0].position[0] - before.objects[0].position[0];
  expect(Math.abs(delta)).toBeGreaterThan(0.01);
  expect(moved.objects[1].position[0] - before.objects[1].position[0]).toBeCloseTo(delta, 8);
  for (let i = 0; i < 2; i++)
    expect(moved.objects[i].position.slice(1)).toEqual(before.objects[i].position.slice(1));
  await page.keyboard.press('r');
  await expect(page.locator('.status-hint')).toContainText('Confirm');
  await page.keyboard.press('z');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3, { button: 'right' });
  expect((await call(page, 'get_state')).objects).toEqual(moved.objects);
  await rows.first().click();
  await expect(page.getByLabel('Object name', { exact: true })).toBeDisabled();
  await page.getByLabel('Position X', { exact: true }).focus();
  await page.keyboard.press('g');
  await page.keyboard.press('Escape');
  expect((await call(page, 'get_state')).objects[0].position).toEqual(moved.objects[0].position);
  await call(page, 'translate_objects', { ids: [before.objects[0].id], delta: [0, 0, 0.1] });
  await expect(
    page.getByRole('button', { name: 'Import OBJ', exact: true, includeHidden: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('list', { name: 'Recorded calls' }).getByRole('listitem').last(),
  ).toHaveAttribute('aria-label', /translate_objects/);
});

test('free playback and local visibility never change agent captures or saved cameras', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page);
  await page
    .getByLabel('Episode file', { exact: true })
    .setInputFiles(resolve('examples/two-objects.episode.zip'));
  await expect(
    page.locator('.viewport-toolbar').getByRole('button', { name: 'Camera View', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const original = unzipSync(await readFile(resolve('examples/two-objects.episode.zip')));
  const image = (await call(page, 'capture_scene')).content[0].data;
  const first = page.locator('[data-object-id]').first();
  await first.getByRole('button', { name: /^Hide / }).click();
  await first.getByRole('button', { name: /^Lock selection / }).click();
  await page
    .locator('.viewport-toolbar')
    .getByRole('button', { name: 'Free View', exact: true })
    .click();
  const canvas = page.getByLabel('3D viewport', { exact: true }),
    box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.7, { steps: 5 });
  await page.mouse.up();
  expect((await call(page, 'capture_scene')).content[0].data).toBe(image);
  await panel(page, 'Display');
  const view = await page.getByLabel('View position X', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Go to initial state', exact: true }).click();
  await expect(page.getByLabel('View position X', { exact: true })).toHaveValue(view);
  await expect(page.getByRole('button', { name: 'View from +X', exact: true })).toBeEnabled();
  expect((await call(page, 'capture_scene')).content[0].data).toBe(image);
  const result = await exported(page);
  for (const name of ['frames.bin', 'frames.jsonl'])
    expect(new TextDecoder().decode(result.files[name])).toEqual(
      new TextDecoder().decode(original[name]),
    );
  const initial = await exported(page, true);
  expect(
    JSON.parse(new TextDecoder().decode(initial.files['frames.jsonl']).split('\n')[0]).camera,
  ).toEqual(JSON.parse(new TextDecoder().decode(original['frames.jsonl']).split('\n')[0]).camera);
  await page
    .locator('.viewport-toolbar')
    .getByRole('button', { name: 'Camera View', exact: true })
    .click();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45, { steps: 3 });
  await page.mouse.up();
  await expect(
    page.locator('.viewport-toolbar').getByRole('button', { name: 'Free View', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: info.outputPath('free-playback.png') });
  expect(errors).toEqual([]);
});
