// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: /feat-saved\.spec\.js$/,
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list']],
  webServer: {
    command: 'python -m http.server 8772 --bind 127.0.0.1',
    cwd: '..',
    port: 8772,
    reuseExistingServer: true,
  },
  use: { baseURL: 'http://127.0.0.1:8772', trace: 'retain-on-failure', headless: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
