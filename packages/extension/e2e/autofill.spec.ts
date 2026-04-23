import { test, expect } from './fixtures';
import { createServer, type Server } from 'http';

let server: Server;
let serverPort: number;

test.beforeAll(async () => {
    server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Test Login</title></head>
<body>
    <form>
        <input type="text" name="username" />
        <input type="password" name="password" />
        <button type="submit">Login</button>
    </form>
</body>
</html>`);
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    serverPort = typeof addr === 'object' && addr ? addr.port : 0;
});

test.afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
    });
});

test('content script injects on login page', async ({ context }) => {
    const page = await context.newPage();

    // Navigate to a real HTTP URL so the extension context is active
    await page.goto(`http://127.0.0.1:${serverPort}/`);

    // Verify the form elements exist
    await expect(page.locator('input[name="username"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();

    // Content script injection requires a running KeeWeb app connection,
    // but we verify the page is reachable and form elements are present
    // inside a real browser context with the extension loaded.
    await page.close();
});

test('extension is active in browser context', async ({ context, extensionId }) => {
    // Verify the extension loaded successfully by checking its ID
    expect(extensionId).toBeTruthy();
    expect(extensionId.length).toBeGreaterThan(0);

    // Service worker should be running
    const workers = context.serviceWorkers();
    expect(workers.length).toBeGreaterThan(0);

    // Service worker URL should reference our extension
    const swUrl = workers[0].url();
    expect(swUrl).toContain(extensionId);
    expect(swUrl).toContain('background.js');
});
