import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function transfer(page: Page, files: { name: string; bytes: number[] }[]) {
  return page.evaluateHandle((files) => {
    const data = new DataTransfer();
    for (const file of files) data.items.add(new File([new Uint8Array(file.bytes)], file.name));
    return data;
  }, files);
}
async function episode(page: Page, name = 'scene.episode.zip', initial = false) {
  const bytes = Array.from(
    await readFile(`examples/two-objects${initial ? '.initial' : ''}.episode.zip`),
  );
  return transfer(page, [{ name, bytes }]);
}
async function start(page: Page) {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Import OBJ', exact: true, includeHidden: true }),
  ).toBeEnabled();
}

test('episode ZIP drops open from the viewport and inspectors without taking over panel drags', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await start(page);
  const dataTransfer = await episode(page, 'scene.EPISODE.ZIP');
  const canvas = page.getByLabel('3D viewport', { exact: true });
  await canvas.dispatchEvent('dragenter', { dataTransfer });
  await expect(page.locator('.episode-drop-indicator')).toBeVisible();
  await expect(page.locator('.status-hint')).toHaveText('Drop an episode ZIP to open');
  const outliner = page.locator('.outliner');
  await outliner.dispatchEvent('dragenter', { dataTransfer });
  await canvas.dispatchEvent('dragleave', { dataTransfer });
  await expect(page.locator('.episode-drop-indicator')).toBeVisible();
  await outliner.dispatchEvent('dragleave', { dataTransfer });
  await expect(page.locator('.episode-drop-indicator')).toHaveCount(0);
  await canvas.dispatchEvent('dragenter', { dataTransfer });
  await page.screenshot({ path: info.outputPath('episode-drop.png') });
  expect(
    await canvas.evaluate((canvas, dataTransfer) => {
      const event = new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true });
      canvas.dispatchEvent(event);
      return event.defaultPrevented;
    }, dataTransfer),
  ).toBe(true);
  await canvas.dispatchEvent('drop', { dataTransfer });
  await expect(page.locator('[data-object-id]')).toHaveCount(2);
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('1');
  await expect(page.locator('.episode-drop-indicator')).toHaveCount(0);
  const initial = await episode(page, 'initial.zip', true);
  await outliner.dispatchEvent('drop', { dataTransfer: initial });
  await expect(
    page.getByRole('button', { name: 'Import OBJ', exact: true, includeHidden: true }),
  ).toBeEnabled();
  expect(page.url()).toMatch(/\/$/);
  const internal = await page.evaluate(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', 'panel');
    return ['dragenter', 'dragover', 'drop'].map((type) => {
      const event = new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true });
      document.querySelector('.menubar')!.dispatchEvent(event);
      return event.defaultPrevented;
    });
  });
  expect(internal).toEqual([false, false, false]);
  await expect(page.locator('.episode-drop-indicator')).toHaveCount(0);
  expect(errors).toEqual([]);
  await dataTransfer.dispose();
  await initial.dispose();
});

test('cancelled, invalid and multiple file drops preserve the unsaved scene', async ({ page }) => {
  await start(page);
  await page
    .getByLabel('OBJ files', { exact: true })
    .setInputFiles('tests/fixtures/split-parts.obj');
  const rows = page.locator('[data-object-id]');
  await expect(rows).toHaveCount(2);
  const ids = await rows.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-object-id')),
  );
  const valid = await episode(page);
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('unsaved');
    await dialog.dismiss();
  });
  await page.locator('.menubar').dispatchEvent('drop', { dataTransfer: valid });
  await expect(page.locator('.window-title')).toContainText('•');
  expect(
    await rows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-object-id'))),
  ).toEqual(ids);
  for (const files of [
    [{ name: 'notes.txt', bytes: [1] }],
    [
      { name: 'one.zip', bytes: [1] },
      { name: 'two.zip', bytes: [2] },
    ],
    [{ name: 'broken.zip', bytes: [1, 2, 3] }],
  ]) {
    const dataTransfer = await transfer(page, files);
    if (files[0].name === 'broken.zip') page.once('dialog', (dialog) => dialog.accept());
    await page.locator('footer').dispatchEvent('drop', { dataTransfer });
    await expect(page.locator('.status-error')).toBeVisible();
    expect(
      await rows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-object-id'))),
    ).toEqual(ids);
    await expect(
      page.getByRole('button', { name: 'Import OBJ', exact: true, includeHidden: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await dataTransfer.dispose();
  }
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('footer').dispatchEvent('drop', { dataTransfer: valid });
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('1');
  await expect(page.locator('.window-title')).not.toContainText('•');
  await valid.dispose();
});

test('an in-flight file open rejects another drop and blocks scene edits until completion', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== 'slow.zip') return original.call(this);
      return new Promise<ArrayBuffer>((resolve, reject) => {
        (window as any).__releaseEpisode = () => original.call(this).then(resolve, reject);
      });
    };
  });
  await start(page);
  const slow = await episode(page, 'slow.zip'),
    next = await episode(page, 'next.zip', true);
  await page.locator('.menubar').dispatchEvent('drop', { dataTransfer: slow });
  await expect(page.locator('.status-mode')).toHaveText('Loading');
  await expect(
    page.getByRole('button', { name: 'Import OBJ', exact: true, includeHidden: true }),
  ).toBeDisabled();
  await page.locator('.menubar').dispatchEvent('dragover', { dataTransfer: next });
  expect(await next.evaluate((data) => data.dropEffect)).toBe('none');
  await page.locator('.menubar').dispatchEvent('drop', { dataTransfer: next });
  await expect(page.locator('.status-error')).toContainText('Wait for the current operation');
  await page.evaluate(() => (window as any).__releaseEpisode());
  await expect(page.getByLabel('Current operation', { exact: true })).toHaveValue('1');
  await expect(page.locator('.status-mode')).not.toHaveText('Loading');
  await slow.dispose();
  await next.dispose();
});
