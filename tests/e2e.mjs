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
if (process.env.CHROME_PATH) {
  launchOptions.executablePath = process.env.CHROME_PATH;
} else {
  launchOptions.channel = 'chrome';
}
const browser = await chromium.launch(launchOptions);

const issues = [];
const collect = (label, page) => {
  page.on('pageerror', (error) => issues.push(`${label} pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') issues.push(`${label} console: ${message.text()}`);
  });
};

const contextA = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'ru-RU',
  timezoneId: 'Asia/Vladivostok',
  permissions: ['clipboard-read', 'clipboard-write']
});
const contextB = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  locale: 'ru-RU',
  timezoneId: 'Asia/Vladivostok'
});
const pageA = await contextA.newPage();
const pageB = await contextB.newPage();
collect('A', pageA);
collect('B', pageB);

async function waitScreen(page, name, timeout = 40000) {
  await page.waitForFunction(
    (screenName) => {
      const element = document.querySelector(`[data-screen="${screenName}"]`);
      return element && !element.hidden;
    },
    name,
    { timeout }
  );
}

async function shipCells(page) {
  return page.$$eval('#own-board .cell--ship', (cells) =>
    cells.map((cell) => [Number(cell.dataset.x), Number(cell.dataset.y)])
  );
}

async function waitCellState(page, boardSelector, x, y, states, timeout = 12000) {
  await page.waitForFunction(
    ({ selector, cx, cy, allowed }) => {
      const cell = document.querySelector(`${selector} .cell[data-x="${cx}"][data-y="${cy}"]`);
      return cell && allowed.some((name) => cell.classList.contains(name));
    },
    { selector: boardSelector, cx: x, cy: y, allowed: states },
    { timeout }
  );
}

async function shoot(page, x, y) {
  await page.locator(`#enemy-board .cell[data-x="${x}"][data-y="${y}"]`).click();
}

async function waitForTurn(page, turn, timeout = 10000) {
  try {
    await page.waitForFunction(
      (expected) => document.getElementById('turn-banner')?.dataset.turn === expected,
      turn,
      { timeout }
    );
  } catch (error) {
    const snapshot = await page.evaluate(() => ({
      turn: document.getElementById('turn-banner')?.dataset.turn,
      title: document.getElementById('turn-title')?.textContent,
      subtitle: document.getElementById('turn-subtitle')?.textContent,
      pending: Array.from(document.querySelectorAll('#enemy-board .cell--pending')).map((cell) => [cell.dataset.x, cell.dataset.y]),
      modalHidden: document.getElementById('modal')?.hidden,
      modalTitle: document.getElementById('modal-title')?.textContent,
      log: Array.from(document.querySelectorAll('#game-log .log-entry')).map((entry) => entry.textContent),
      hits: document.querySelectorAll('#enemy-board .cell--hit').length,
      sunk: document.querySelectorAll('#enemy-board .cell--sunk').length
    }));
    console.log('TURN WAIT FAILED', turn, snapshot);
    await page.screenshot({ path: `${SHOTS}/failure-turn.png`, fullPage: true });
    throw error;
  }
}

console.log('1. Открываем лобби и создаём комнату…');
await pageA.goto(BASE, { waitUntil: 'networkidle' });
await pageA.screenshot({ path: `${SHOTS}/01-lobby-desktop.png`, fullPage: true });
await pageA.click('#btn-create');
await pageA.waitForFunction(() => document.querySelector('#room-id')?.textContent.startsWith('bsb-'), null, { timeout: 45000 });
const roomId = (await pageA.locator('#room-id').innerText()).trim();
console.log('   ID комнаты:', roomId);
assert.match(roomId, /^bsb-[cxw]-[a-z0-9]{8}$/);
await pageA.screenshot({ path: `${SHOTS}/02-create-desktop.png`, fullPage: true });

console.log('2. Присоединяемся вторым клиентом…');
await pageB.goto(`${BASE}?room=${encodeURIComponent(roomId)}`, { waitUntil: 'networkidle' });
await waitScreen(pageB, 'join');
assert.equal((await pageB.locator('#join-input').inputValue()).trim(), roomId);
await pageB.screenshot({ path: `${SHOTS}/03-join-mobile.png`, fullPage: true });
await pageB.click('#btn-connect');
await Promise.all([waitScreen(pageA, 'placement'), waitScreen(pageB, 'placement')]);
console.log('   Оба клиента на экране расстановки');

console.log('3. Расставляем флоты и начинаем бой…');
await Promise.all([pageA.click('#btn-random'), pageB.click('#btn-random')]);
assert.equal(await pageA.locator('#placement-board .cell--ship').count(), 20);
assert.equal(await pageB.locator('#placement-board .cell--ship').count(), 20);
await pageA.screenshot({ path: `${SHOTS}/04-placement-desktop.png`, fullPage: true });
await pageB.screenshot({ path: `${SHOTS}/05-placement-mobile.png`, fullPage: true });
await Promise.all([pageA.click('#btn-ready'), pageB.click('#btn-ready')]);
await Promise.all([waitScreen(pageA, 'game'), waitScreen(pageB, 'game')]);
console.log('   Игра началась. Хост ходит первым.');
await waitForTurn(pageA, 'you');
await waitForTurn(pageB, 'opponent');
await pageA.waitForTimeout(600);
await pageA.screenshot({ path: `${SHOTS}/06-game-desktop.png`, fullPage: true });
await pageB.screenshot({ path: `${SHOTS}/07-game-mobile.png`, fullPage: true });

const bShips = await shipCells(pageB);
const aShips = await shipCells(pageA);
assert.equal(bShips.length, 20);
assert.equal(aShips.length, 20);
const key = ([x, y]) => `${x}:${y}`;
const bSet = new Set(bShips.map(key));
const aSet = new Set(aShips.map(key));
const allCells = [];
for (let y = 0; y < 10; y += 1) for (let x = 0; x < 10; x += 1) allCells.push([x, y]);
const bWater = allCells.find((cell) => !bSet.has(key(cell)));
const aWater = allCells.find((cell) => !aSet.has(key(cell)));

console.log('4. Проверяем промах, передачу хода и ответный выстрел…');
await shoot(pageA, bWater[0], bWater[1]);
await waitCellState(pageB, '#own-board', bWater[0], bWater[1], ['cell--miss']);
await waitCellState(pageA, '#enemy-board', bWater[0], bWater[1], ['cell--miss']);
await waitForTurn(pageA, 'opponent');
await waitForTurn(pageB, 'you');
await shoot(pageB, aWater[0], aWater[1]);
await waitCellState(pageA, '#own-board', aWater[0], aWater[1], ['cell--miss']);
await waitForTurn(pageA, 'you');
await waitForTurn(pageB, 'opponent');
console.log('   Ход корректно перешёл к сопернику и обратно');

console.log('5. Топим весь флот соперника (20 попаданий)…');
for (let index = 0; index < bShips.length; index += 1) {
  const [x, y] = bShips[index];
  await shoot(pageA, x, y);
  await waitCellState(pageA, '#enemy-board', x, y, ['cell--hit', 'cell--sunk']);
  await pageA.waitForFunction(
    () => document.getElementById('turn-banner')?.dataset.turn === 'you' || !document.getElementById('modal')?.hidden,
    null,
    { timeout: 10000 }
  );
  const modalVisible = await pageA.locator('#modal:not([hidden])').count();
  if (modalVisible) break;
  await waitForTurn(pageA, 'you');
  if ((index + 1) % 5 === 0 || index > 12) {
    const turn = await pageA.locator('#turn-banner').getAttribute('data-turn');
    console.log(`   ${index + 1}/20 (${x}:${y}), turn=${turn}, hits=${await pageA.locator('#enemy-board .cell--hit').count()}, sunk=${await pageA.locator('#enemy-board .cell--sunk').count()}`);
  }
}
await pageA.waitForSelector('#modal:not([hidden])', { timeout: 12000 });
await pageB.waitForSelector('#modal:not([hidden])', { timeout: 12000 });
assert.match(await pageA.locator('#modal-title').innerText(), /Победа/);
assert.match(await pageB.locator('#modal-title').innerText(), /Поражение/);
assert.equal(await pageB.locator('#own-board .cell--sunk').count(), 20);
console.log('   Победа и поражение отображаются корректно');
await pageA.screenshot({ path: `${SHOTS}/08-victory-desktop.png`, fullPage: true });
await pageB.screenshot({ path: `${SHOTS}/09-defeat-mobile.png`, fullPage: true });

console.log('6. Проверяем реванш…');
await pageA.locator('#modal-actions button', { hasText: 'Реванш' }).click();
await pageB.locator('#modal-actions button', { hasText: 'Принять' }).click({ timeout: 15000 });
await Promise.all([waitScreen(pageA, 'placement'), waitScreen(pageB, 'placement')]);
assert.equal(await pageA.locator('#placement-board .cell--ship').count(), 0);
assert.equal(await pageB.locator('#placement-board .cell--ship').count(), 0);
console.log('   Реванш начался заново');

console.log('7. Проверяем сдачу во втором бою…');
await Promise.all([pageA.click('#btn-random'), pageB.click('#btn-random')]);
await Promise.all([pageA.click('#btn-ready'), pageB.click('#btn-ready')]);
await Promise.all([waitScreen(pageA, 'game'), waitScreen(pageB, 'game')]);
await waitForTurn(pageA, 'you');
await pageA.click('#btn-resign');
await pageA.locator('#modal-actions button', { hasText: 'Сдаться' }).click();
await pageA.waitForSelector('#modal:not([hidden])', { timeout: 12000 });
await pageB.waitForSelector('#modal:not([hidden])', { timeout: 12000 });
assert.match(await pageA.locator('#modal-title').innerText(), /Поражение/);
assert.match(await pageB.locator('#modal-title').innerText(), /Победа/);
console.log('   Сдача корректно завершает бой');

console.log('8. Проверяем выход соперника…');
await pageB.locator('#modal-actions button', { hasText: 'В лобби' }).click();
await pageA.waitForFunction(() => /Связь потеряна|Соперник вышел/.test(document.getElementById('modal-title')?.textContent || ''), null, { timeout: 20000 });
console.log('   Выход соперника обработан');
await pageA.screenshot({ path: `${SHOTS}/10-opponent-left-desktop.png`, fullPage: true });
await pageA.locator('#modal-actions button', { hasText: 'В лобби' }).click();
await waitScreen(pageA, 'lobby');

console.log('9. Проверяем валидацию ID…');
const pageC = await contextA.newPage();
collect('C', pageC);
await pageC.goto(BASE, { waitUntil: 'networkidle' });
await pageC.click('#btn-join');
await pageC.fill('#join-input', 'неверный id!');
await pageC.click('#btn-connect');
await pageC.waitForSelector('#join-error:not([hidden])', { timeout: 5000 });
assert.match(await pageC.locator('#join-error').innerText(), /некорректно/i);
await pageC.close();

await browser.close();

const relevantIssues = issues.filter((message) =>
  !message.includes('favicon') &&
  !message.includes('net::ERR_ABORTED') &&
  !message.includes('Failed to load resource') &&
  !message.includes('0.peerjs.com') &&
  !message.includes('Lost connection to server')
);
console.log('');
console.log('Проверки пройдены. Ошибки в консоли:', relevantIssues.length ? relevantIssues : 'нет');
if (relevantIssues.length) {
  console.log(relevantIssues.join('\n'));
  process.exitCode = 1;
}
