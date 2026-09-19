import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

// Automated WCAG 2.2 AA guard (KRA-87). Runs axe-core against the public pages in
// both colour schemes and fails on any violation, so a future style change can't
// silently regress contrast, labels, roles, or link distinguishability.
const PAGES = [
  { name: 'landing', url: '/' },
  { name: 'support', url: '/support.html' },
  { name: 'privacy', url: '/privacy.html' },
  { name: 'terms', url: '/terms.html' },
  { name: 'login', url: '/login' },
  { name: 'signup', url: '/signup' },
];
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

for (const scheme of ['light', 'dark']) {
  test.describe(`a11y (${scheme})`, () => {
    test.use({ colorScheme: scheme });
    for (const pg of PAGES) {
      test(`${pg.name} has no WCAG 2.2 AA violations`, async ({ page }) => {
        await page.goto(pg.url, { waitUntil: 'networkidle' });
        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        const summary = results.violations.map(
          (v) => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(' ')}`,
        );
        expect(summary, summary.join('\n')).toEqual([]);
      });
    }
  });
}
