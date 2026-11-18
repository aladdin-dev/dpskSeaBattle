/*
 * e2e-two-browsers.mjs — шаблон проверки P2P-сессии двумя реальными браузерами.
 *
 * Установка и запуск:
 *   npm install --no-save playwright-core
 *   node e2e-two-browsers.mjs                       # локальный сервер
 *   GAME_URL=https://user.github.io/app/ node e2e-two-browsers.mjs
 *
 * Запускает два изолированных контекста (десктоп + мобильный), проходит
 * рукопожатие через настоящий PeerJS и проверяет, что оба клиента вышли в
 * состояние «online». Дальше добавьте шаги своего приложения — пример внизу.
 *
 * Требуется установленный Chrome (channel: 'chrome') или переменная CHROME_PATH.
 */

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const BASE = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const SHOTS = 'test-artifacts';
await mkdir(SHOTS, { recursive: true });

const launchOptions = {
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-crash-reporter']
};
if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;
else launchOptions.channel = 'chrome';

const browser = await chromium.launch(launchOptions);
const issues = [];

function watch(page, label) {
  page.on('pageerror', (error) => issues.push(`${label} pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') issues.push(`${label} console: ${message.text()}`);
  });
}

const hostContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
const guestContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
  locale: 'ru-RU'
});
const host = await hostContext.newPage();
const guest = await guestContext.newPage();
watch(host, 'host');
watch(guest, 'guest');

const waitVisible = (page, selector, timeout = 45000) =>
  page.waitForSelector(selector, { state: 'visible', timeout });

const waitOnline = (page) =>
  page.waitForFunction(
    () => /online|connected/i.test(document.querySelector('#status-pill')?.dataset.state || ''),
    null,
    { timeout: 45000 }
  );

console.log('1. Хост создаёт комнату…');
await host.goto(BASE, { waitUntil: 'networkidle' });
await host.click('#btn-create');
await waitVisible(host, '#room-id');
await host.waitForFunction(
  () => /^[a-z]+-[a-z]-/i.test(document.querySelector('#room-id')?.textContent || ''),
  null,
  { timeout: 45000 }
);
const roomCode = (await host.locator('#room-id').textContent()).trim();
assert.match(roomCode, /^[a-z]+-[a-z]-[a-z0-9]{6,}$/i, `неожиданный код комнаты: ${roomCode}`);
console.log('   код:', roomCode);

console.log('2. Гость открывает ссылку и подключается…');
await guest.goto(`${BASE}?room=${encodeURIComponent(roomCode)}`, { waitUntil: 'networkidle' });
await waitVisible(guest, '#join-input');
assert.equal(
  (await guest.locator('#join-input').inputValue()).trim(),
  roomCode,
  'код из ссылки должен подставляться в поле'
);
await guest.click('#btn-connect');
await Promise.all([waitOnline(host), waitOnline(guest)]);
console.log('   оба клиента в сети');

await host.screenshot({ path: `${SHOTS}/e2e-host.png`, fullPage: true });
await guest.screenshot({ path: `${SHOTS}/e2e-guest.png`, fullPage: true });

/*
 * 3. Дальше проверяйте своё приложение через UI, а не через внутренние объекты.
 *    Пример для игры: хост стреляет, у гостя обновляется поле.
 *
 *      await host.locator('#enemy-board .cell[data-x="0"][data-y="0"]').click();
 *      await guest.waitForFunction(
 *        () => document.querySelector('#own-board .cell--miss') !== null,
 *        null,
 *        { timeout: 10000 }
 *      );
 *
 *    Полезные инварианты для P2P:
 *      - после действия одного клиента второй показывает тот же результат;
 *      - повторная отправка не дублирует состояние (idempotency);
 *      - при закрытии вкладки второго игрока первый получает экран «связь потеряна»;
 *      - некорректный код комнаты даёт понятную ошибку, а не вечный спиннер.
 */

const relevantIssues = issues.filter(
  (message) =>
    !message.includes('favicon') &&
    !message.includes('net::ERR_ABORTED') &&
    !message.includes('Failed to load resource') &&
    !message.includes('0.peerjs.com') &&
    !message.includes('Lost connection to server')
);
console.log('');
console.log('Проверки пройдены. Ошибки в консоли:', relevantIssues.length ? relevantIssues : 'нет');
if (relevantIssues.length) process.exitCode = 1;

await browser.close();
