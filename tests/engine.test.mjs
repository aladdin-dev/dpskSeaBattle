import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Engine = require('../js/engine.js');

function sampleLayout() {
  const board = Engine.createBoard();
  Engine.placeShip(board, 4, 0, 0, true);
  Engine.placeShip(board, 3, 0, 2, true);
  Engine.placeShip(board, 3, 5, 2, true);
  Engine.placeShip(board, 2, 0, 4, true);
  Engine.placeShip(board, 2, 3, 4, true);
  Engine.placeShip(board, 2, 6, 4, true);
  [[0, 6], [2, 6], [4, 6], [6, 6]].forEach(([x, y]) => {
    Engine.placeShip(board, 1, x, y, true);
  });
  return board;
}

test('новое поле пустое, размер 10×10', () => {
  const board = Engine.createBoard();
  assert.equal(board.grid.length, 100);
  assert.equal(board.shots.length, 100);
  assert.equal(board.ships.length, 0);
  assert.ok(Engine.inBounds(9, 9));
  assert.equal(Engine.inBounds(10, 0), false);
});

test('корабль нельзя поставить за границей или вплотную', () => {
  const board = Engine.createBoard();
  assert.ok(Engine.placeShip(board, 4, 0, 0, true));
  assert.equal(Engine.canPlace(board, 3, 4, 1, false), false, 'касание углом');
  assert.equal(Engine.canPlace(board, 3, 4, 0, true), false, 'касание бортом');
  assert.equal(Engine.canPlace(board, 4, 7, 5, true), false, 'выход за границу');
  assert.equal(Engine.canPlace(board, 4, 6, 5, true), true, 'свободное место');
});

test('валидная расстановка проходит проверку и восстанавливается из JSON', () => {
  const layout = Engine.serializeLayout(sampleLayout());
  assert.equal(layout.length, 10);
  const result = Engine.validateLayout(JSON.parse(JSON.stringify(layout)));
  assert.equal(result.ok, true);
  assert.equal(result.board.ships.length, 10);
  assert.equal(Engine.countPlacedCells(result.board), 20);
  assert.deepEqual(
    result.board.ships.map((ship) => ship.size).sort(),
    [1, 1, 1, 1, 2, 2, 2, 3, 3, 4]
  );
});

test('валидация отклоняет касание углами, пересечение и неверный флот', () => {
  const touching = Engine.serializeLayout(sampleLayout());
  touching[6].cells = [[1, 5]]; // катер вплотную к эсминцу
  assert.equal(Engine.validateLayout(touching).error, 'touching');

  const overlap = Engine.serializeLayout(sampleLayout());
  overlap[6].cells = [[0, 0]];
  assert.equal(Engine.validateLayout(overlap).error, 'overlap');

  const wrongFleet = Engine.serializeLayout(sampleLayout()).slice(0, 9);
  assert.equal(Engine.validateLayout(wrongFleet).error, 'fleet-size');

  const bent = Engine.serializeLayout(sampleLayout());
  bent[0].cells = [[0, 0], [1, 0], [2, 0], [2, 1]];
  assert.equal(Engine.validateLayout(bent).error, 'not-straight');
});

test('выстрел: промах, попадание, потопление и повторный выстрел', () => {
  const board = sampleLayout();

  const miss = Engine.registerShot(board, 9, 9);
  assert.equal(miss.result, 'miss');
  assert.equal(Engine.shotAt(board, 9, 9), 'miss');
  assert.equal(Engine.registerShot(board, 9, 9).error, 'already-shot');

  const hit = Engine.registerShot(board, 0, 0);
  assert.equal(hit.result, 'hit');
  assert.equal(Engine.shotAt(board, 0, 0), 'hit');

  const sunk = Engine.registerShot(board, 1, 0);
  assert.equal(sunk.result, 'hit');

  const finisher = Engine.registerShot(board, 2, 0);
  assert.equal(finisher.result, 'hit');

  const last = Engine.registerShot(board, 3, 0);
  assert.equal(last.result, 'sunk');
  assert.equal(last.gameOver, false);
  assert.equal(last.sunkCells.length, 4);
  last.sunkCells.forEach(([x, y]) => {
    assert.equal(Engine.shotAt(board, x, y), 'sunk');
  });
  assert.equal(Engine.fleetStatus(board).sunk, 1);
});

test('потопление всего флота завершает игру', () => {
  const board = sampleLayout();
  let gameOver = false;
  for (const ship of board.ships) {
    for (const cell of ship.cells) {
      const shot = Engine.registerShot(board, cell.x, cell.y);
      assert.equal(shot.ok, true);
      gameOver = shot.gameOver;
    }
  }
  assert.equal(gameOver, true);
  assert.equal(Engine.allShipsSunk(board), true);
  assert.equal(Engine.fleetStatus(board).afloat, 0);
});

test('результат выстрела корректно применяется на поле стрелявшего', () => {
  const layout = Engine.serializeLayout(sampleLayout());
  const enemy = Engine.validateLayout(layout).board;

  assert.equal(Engine.applyShotResult(enemy, 9, 0, 'miss'), true);
  assert.equal(Engine.shotAt(enemy, 9, 0), 'miss');

  assert.equal(Engine.applyShotResult(enemy, 0, 2, 'sunk', [[0, 2], [1, 2], [2, 2]]), true);
  assert.equal(Engine.shotAt(enemy, 1, 2), 'sunk');
  assert.equal(Engine.shotAt(enemy, 2, 2), 'sunk');
  assert.equal(Engine.fleetStatus(enemy).sunk, 1);
});

test('случайная расстановка всегда валидна', () => {
  let seed = 123456789;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 40; i += 1) {
    const board = Engine.randomLayout(rng);
    const layout = Engine.serializeLayout(board);
    const validation = Engine.validateLayout(layout);
    assert.equal(validation.ok, true, `попытка ${i}: ${validation.message || ''}`);
    assert.equal(Engine.countPlacedCells(board), 20);
  }
});

test('отмена последнего корабля освобождает его клетки', () => {
  const board = sampleLayout();
  const removed = Engine.undoLastShip(board);
  assert.ok(removed);
  assert.equal(board.ships.length, 9);
  assert.equal(board.grid[Engine.indexOf(6, 6)], null);
  assert.equal(Engine.countPlacedCells(board), 19);
});
