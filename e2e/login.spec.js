import { test, expect } from '@playwright/test';

// Smoke test: a user can sign in with email/password and reach the dashboard.
// Credentials come from the environment so they're never committed:
//   E2E_EMAIL / E2E_PASSWORD  (a dedicated staging account)
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

test('user can log in and lands on the main dashboard', async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD to run this test.');

  await page.goto('/app.html');

  // Auth screen: fill the login form and submit.
  await expect(page.locator('#em')).toBeVisible();
  await page.fill('#em', EMAIL);
  await page.fill('#pw', PASSWORD);
  await page.click('#authBtn');

  // Success = the dashboard shell is shown and the auth screen is gone.
  await expect(page.locator('#appView')).toBeVisible();
  await expect(page.locator('#authView')).toBeHidden();
  await expect(page.locator('#viewTitle')).toHaveText('Home');
});
