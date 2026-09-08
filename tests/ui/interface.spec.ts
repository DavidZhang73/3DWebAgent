import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

async function ready(page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Object properties', exact: true })).toBeVisible();
}

test('icon tooltips explain disabled controls and popovers return keyboard focus', async ({
  page,
}) => {
  await ready(page);
  await page.getByText('View', { exact: true }).click();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  const play = page.getByRole('button', { name: 'Play history', exact: true });
  await expect(play).toBeDisabled();
  await play.hover();
  await expect(page.getByRole('tooltip')).toContainText('No recorded calls to play.');
  await expect(page.getByRole('tooltip')).toContainText('Space');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await play.focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Pause playback', exact: true })).toHaveCount(0);
  const overlays = page.getByRole('button', { name: 'Overlays', exact: true });
  await overlays.click();
  const popover = page.getByRole('dialog', { name: 'Overlays' });
  await expect(popover).toBeVisible();
  await popover.getByLabel('Grid', { exact: true }).uncheck();
  await expect(popover.getByLabel('Grid', { exact: true })).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(overlays).toBeFocused();
  await page.setViewportSize({ width: 1000, height: 760 });
  await overlays.focus();
  await overlays.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  const rect = (await page.getByRole('tooltip').boundingBox())!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(1000);
  expect(rect.y + rect.height).toBeLessThanOrEqual(760);
});

test('property categories follow selection, preserve advanced folds and expose all settings', async ({
  page,
}) => {
  await ready(page);
  await page
    .getByLabel('Episode file', { exact: true })
    .setInputFiles(resolve('examples/two-objects.initial.episode.zip'));
  await page.locator('[data-object-id]').first().click();
  await expect(page.getByLabel('Object name', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Mass', { exact: true })).toHaveCount(0);
  for (const name of ['Object', 'Physics', 'World', 'Display', 'WebMCP']) {
    await page.getByRole('tab', { name: name + ' properties', exact: true }).click();
    await expect(
      page.getByRole('tabpanel', { name: name + ' properties', exact: true }),
    ).toHaveAttribute('aria-labelledby', 'property-tab-' + name.toLowerCase());
    await page.screenshot({
      path: test.info().outputPath('properties-' + name.toLowerCase() + '.png'),
    });
  }
  await page.getByRole('tab', { name: 'Physics properties', exact: true }).click();
  await expect(page.getByLabel('Mass', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Principal inertia X', { exact: true })).not.toBeVisible();
  await page
    .locator('.object-row')
    .filter({ hasText: /^Camera$/ })
    .click();
  await expect(page.getByLabel('Mass', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText(/Cameras and groups have no independent physics settings/),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Object properties', exact: true }).click();
  await expect(page.getByLabel('Camera position X', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Object properties', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tab', { name: 'Physics properties', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.getByRole('tab', { name: 'World properties', exact: true }).click();
  await expect(page.getByLabel('Enable physics', { exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await page.getByLabel('Interactive 3D scene', { exact: true }).boundingBox())!.width,
    )
    .toBeLessThan(800);
  await page.waitForTimeout(150);
  expect(await page.locator('.app').evaluate((el) => el.scrollLeft)).toBe(0);
  await page.screenshot({ path: test.info().outputPath('properties-narrow.png') });
});

test('legacy property panels migrate in place to one persistent properties editor', async ({
  page,
}) => {
  await ready(page);
  const before = (await page.getByLabel('Interactive 3D scene', { exact: true }).boundingBox())!;
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('3dwebagent.layout.v4')!);
    const properties = saved.panels.properties;
    delete saved.panels.properties;
    for (const id of ['physics', 'display', 'tools'])
      saved.panels[id] = { ...properties, id, contentComponent: id, title: id };
    const visit = (node) => {
      if (Array.isArray(node.data)) node.data.forEach(visit);
      else if (node.data.views.includes('properties')) {
        node.data.views = node.data.views.flatMap((id) =>
          id === 'properties' ? ['physics', 'display', 'tools'] : [id],
        );
        node.data.activeView = 'display';
        saved.activeGroup = node.data.id;
      }
    };
    visit(saved.grid.root);
    localStorage.removeItem('3dwebagent.layout.v4');
    localStorage.setItem('3dwebagent.layout.v3', JSON.stringify(saved));
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Display properties', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.properties-editor')).toHaveCount(1);
  const after = (await page.getByLabel('Interactive 3D scene', { exact: true }).boundingBox())!;
  expect(Math.abs(before.width - after.width)).toBeLessThan(2);
  expect(Math.abs(before.height - after.height)).toBeLessThan(2);
  const ids = await page.evaluate(() =>
    Object.keys(JSON.parse(localStorage.getItem('3dwebagent.layout.v4')!).panels),
  );
  expect(ids).toContain('properties');
  expect(ids).not.toContain('physics');
  expect(ids).not.toContain('display');
  expect(ids).not.toContain('tools');
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Display properties', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByText('View', { exact: true }).click();
  await page.getByRole('button', { name: 'World', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'World properties', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByText('View', { exact: true }).click();
  await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
  await expect(page.locator('.properties-editor')).toHaveCount(1);
});
