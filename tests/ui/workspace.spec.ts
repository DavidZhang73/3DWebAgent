import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';

test('theme, menus and snapshot timeline preserve the loaded episode', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Import OBJ', exact: true })).toBeEnabled();
  await page
    .getByLabel('Episode file', { exact: true })
    .setInputFiles(resolve('examples/two-objects.episode.zip'));
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('1');
  await expect(
    page.getByRole('list', { name: 'Recorded calls' }).getByRole('listitem'),
  ).toHaveCount(1);
  for (const [name, label] of [
    ['latte', 'Latte'],
    ['frappe', 'Frappé'],
    ['macchiato', 'Macchiato'],
    ['mocha', 'Mocha'],
  ]) {
    await page.getByText('Theme', { exact: true }).click();
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', name);
    await expect(page.locator('.menu-popover:visible')).toHaveCount(0);
    await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('1');
    await page.screenshot({ path: test.info().outputPath(name + '.png') });
  }
  await page.getByRole('button', { name: 'Go to initial state', exact: true }).click();
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('0');
  await page.getByRole('list', { name: 'Recorded calls' }).getByRole('listitem').first().click();
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: 'Return to latest', exact: true }).click();
  await page.getByText('View', { exact: true }).click();
  await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('1');
  const downloadPromise = page.waitForEvent('download');
  await page.getByText('File', { exact: true }).click();
  await page.getByRole('button', { name: 'Export full episode…', exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(test.info().outputPath('unchanged.episode.zip'));
  const original = unzipSync(await readFile(resolve('examples/two-objects.episode.zip'))),
    exported = unzipSync(await readFile(test.info().outputPath('unchanged.episode.zip')));
  expect(Object.keys(exported).sort()).toEqual(Object.keys(original).sort());
  for (const name of ['frames.bin', 'frames.jsonl', 'events.jsonl', 'calls.jsonl'])
    expect(new TextDecoder().decode(exported[name])).toEqual(
      new TextDecoder().decode(original[name]),
    );
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'mocha');
  expect(errors).toEqual([]);
});

test('initial editor tools, import and timeline navigation remain editable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Import OBJ', exact: true })).toBeEnabled();
  await page
    .getByLabel('OBJ files', { exact: true })
    .setInputFiles(resolve('tests/fixtures/split-parts.obj'));
  await expect(page.locator('[data-object-id]')).toHaveCount(2);
  await page.locator('[data-object-id]').first().click();
  await page.getByRole('button', { name: 'Select objects', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select objects', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Move objects', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Position X', exact: true }).fill('0.75');
  await page.getByRole('spinbutton', { name: 'Position X', exact: true }).press('Enter');
  await page.getByText('View', { exact: true }).click();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Go to initial state', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Import OBJ', exact: true })).toBeEnabled();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue(
    '0.75',
  );
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('0');
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByLabel('Episode file', { exact: true }).setInputFiles({
    name: 'broken.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('broken'),
  });
  await expect(
    page.getByRole('alert').filter({ hasText: /invalid|corrupt|zip|archive/i }),
  ).toBeVisible();
  await expect(page.locator('[data-object-id]')).toHaveCount(2);
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue(
    '0.75',
  );
});

test('orientation gizmo follows the camera and snaps to six directions', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Import OBJ', exact: true })).toBeEnabled();
  await page.getByText('View', { exact: true }).click();
  await page.getByRole('button', { name: 'Display', exact: true }).click();
  const cameraValues = async (label: string) =>
    Promise.all(
      ['X', 'Y', 'Z'].map((axis) =>
        page
          .getByRole('spinbutton', { name: label + ' ' + axis, exact: true })
          .inputValue()
          .then(Number),
      ),
    );
  const target = await cameraValues('View target'),
    initial = await cameraValues('View position');
  const distance = Math.hypot(...initial.map((v, i) => v - target[i]));
  const x = page.getByRole('button', { name: 'View from +X', exact: true });
  const initialStyle = await x.getAttribute('style');
  for (const [axis, index] of [
    ['X', 0],
    ['Y', 1],
    ['Z', 2],
  ] as const) {
    for (const sign of [1, -1]) {
      await page
        .getByRole('button', { name: `View from ${sign > 0 ? '+' : '−'}${axis}`, exact: true })
        .click();
      await expect
        .poll(async () => {
          const position = await cameraValues('View position');
          return position[index] - target[index];
        })
        .toBeCloseTo(sign * distance, 4);
      expect(await cameraValues('View target')).toEqual(target);
      const position = await cameraValues('View position');
      expect(Math.hypot(...position.map((v, i) => v - target[i]))).toBeCloseTo(distance, 4);
    }
  }
  expect(await x.getAttribute('style')).not.toBe(initialStyle);
  await page.screenshot({ path: test.info().outputPath('orientation-gizmo.png') });
  page.on('dialog', (dialog) => dialog.accept());
  await page
    .getByLabel('Episode file', { exact: true })
    .setInputFiles(resolve('examples/two-objects.episode.zip'));
  await page.getByRole('button', { name: 'Go to initial state', exact: true }).click();
  await expect(x).toBeEnabled();
  await page.getByRole('button', { name: 'Return to latest', exact: true }).click();
  await expect(x).toBeEnabled();
});
