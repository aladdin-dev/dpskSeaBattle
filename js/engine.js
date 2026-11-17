/*
 * «Морской бой» — чистый игровой движок.
 *
 * Не зависит от DOM и PeerJS, поэтому его можно использовать и в браузере,
 * и в Node.js для автотестов. Все координаты — от 0 до 9.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BattleshipEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BOARD_SIZE = 10;
  const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
  const FLEET_SIZES = Object.freeze([4, 3, 3, 2, 2, 2, 1, 1, 1, 1]);
  const SHIP_NAMES = Object.freeze({
    4: 'Линкор',
    3: 'Крейсер',
    2: 'Эсминец',
    1: 'Катер'
  });

  function indexOf(x, y) {
    return y * BOARD_SIZE + x;
  }

  function inBounds(x, y) {
    return Number.isInteger(x) && Number.isInteger(y) &&
      x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
  }

  function coordLabel(x, y) {
    return String.fromCharCode(65 + x) + (y + 1);
  }

  function cellsForShip(x, y, size, horizontal) {
    const cells = [];
    for (let i = 0; i < size; i += 1) {
      cells.push({ x: horizontal ? x + i : x, y: horizontal ? y : y + i });
    }
    return cells;
  }

  function createBoard() {
    return {
      size: BOARD_SIZE,
      grid: new Array(CELL_COUNT).fill(null),
      ships: [],
      shots: new Array(CELL_COUNT).fill(null)
    };
  }

  function getShipAt(board, x, y) {
    if (!inBounds(x, y)) return null;
    const id = board.grid[indexOf(x, y)];
    if (!id) return null;
    return board.ships.find(function (ship) { return ship.id === id; }) || null;
  }

  /**
   * Проверяет, что корабль целиком помещается на поле и не касается
   * других кораблей даже углами.
   */
  function canPlace(board, size, x, y, horizontal) {
    if (!board || !Number.isInteger(size) || size < 1 || size > 4) return false;
    if (!inBounds(x, y)) return false;

    const cells = cellsForShip(x, y, size, Boolean(horizontal));
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      if (!inBounds(cell.x, cell.y)) return false;
      if (board.grid[indexOf(cell.x, cell.y)]) return false;
    }

    // Запрещаем касание бортами и углами: проверяем всех соседей 8 клеток.
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = cell.x + dx;
          const ny = cell.y + dy;
          if (!inBounds(nx, ny)) continue;
          if (board.grid[indexOf(nx, ny)]) return false;
        }
      }
    }
    return true;
  }

  function placeShip(board, size, x, y, horizontal, id) {
    if (!canPlace(board, size, x, y, horizontal)) return null;
    const cells = cellsForShip(x, y, size, Boolean(horizontal));
    const ship = {
      id: id || ('ship-' + board.ships.length + '-' + Date.now().toString(36)),
      size: size,
      cells: cells,
      horizontal: Boolean(horizontal),
      sunk: false
    };
    board.ships.push(ship);
    cells.forEach(function (cell) {
      board.grid[indexOf(cell.x, cell.y)] = ship.id;
    });
    return ship;
  }

  function removeShip(board, shipId) {
    const pos = board.ships.findIndex(function (ship) { return ship.id === shipId; });
    if (pos === -1) return false;
    const ship = board.ships[pos];
    ship.cells.forEach(function (cell) {
      const idx = indexOf(cell.x, cell.y);
      if (board.grid[idx] === shipId) board.grid[idx] = null;
    });
    board.ships.splice(pos, 1);
    return true;
  }

  function undoLastShip(board) {
    if (!board.ships.length) return null;
    const ship = board.ships[board.ships.length - 1];
    removeShip(board, ship.id);
    return ship;
  }

  function serializeLayout(board) {
    return board.ships.map(function (ship) {
      return {
        size: ship.size,
        cells: ship.cells.map(function (cell) {
          return [cell.x, cell.y];
        })
      };
    });
  }

  function emptyValidationError(code, message) {
    return { ok: false, error: code, message: message };
  }

  /**
   * Валидирует расстановку, пришедшую по сети или из локального состояния.
   * Возвращает новый board либо { ok: false, error, message }.
   */
  function validateLayout(layout) {
    if (!Array.isArray(layout)) {
      return emptyValidationError('bad-layout', 'Расстановка должна быть массивом кораблей.');
    }
    if (layout.length !== FLEET_SIZES.length) {
      return emptyValidationError('fleet-size', 'В расстановке должно быть ровно 10 кораблей.');
    }

    const declaredSizes = [];
    const board = createBoard();
    const usedCells = new Set();

    for (let i = 0; i < layout.length; i += 1) {
      const raw = layout[i];
      if (!raw || typeof raw !== 'object') {
        return emptyValidationError('bad-ship', 'Некорректное описание корабля.');
      }
      const size = raw.size;
      const cells = raw.cells;
      if (!Number.isInteger(size) || size < 1 || size > 4) {
        return emptyValidationError('bad-size', 'Некорректный размер корабля.');
      }
      if (!Array.isArray(cells) || cells.length !== size) {
        return emptyValidationError('bad-cells', 'Количество клеток не совпадает с размером корабля.');
      }
      declaredSizes.push(size);

      const normalized = [];
      let sameX = true;
      let sameY = true;
      for (let j = 0; j < cells.length; j += 1) {
        const pair = cells[j];
        if (!Array.isArray(pair) || pair.length !== 2) {
          return emptyValidationError('bad-cell', 'Некорректные координаты клетки.');
        }
        const x = pair[0];
        const y = pair[1];
        if (!inBounds(x, y)) {
          return emptyValidationError('out-of-bounds', 'Клетка находится за пределами поля.');
        }
        const idx = indexOf(x, y);
        if (usedCells.has(idx)) {
          return emptyValidationError('overlap', 'Корабли пересекаются.');
        }
        usedCells.add(idx);
        normalized.push({ x: x, y: y });
        if (j > 0) {
          if (x !== normalized[0].x) sameX = false;
          if (y !== normalized[0].y) sameY = false;
        }
      }
      if (!sameX && !sameY) {
        return emptyValidationError('not-straight', 'Корабль должен быть расположен по прямой линии.');
      }
      // Упорядочиваем клетки вдоль корпуса, чтобы дальше было удобнее.
      normalized.sort(function (a, b) {
        return sameX ? a.y - b.y : a.x - b.x;
      });

      const ship = {
        id: 'ship-' + i,
        size: size,
        cells: normalized,
        horizontal: sameX,
        sunk: false
      };
      board.ships.push(ship);
      normalized.forEach(function (cell) {
        board.grid[indexOf(cell.x, cell.y)] = ship.id;
      });
    }

    // Точное совпадение состава флота, независимо от порядка кораблей.
    const actualSizes = declaredSizes.slice().sort(function (a, b) { return b - a; });
    const expectedSizes = FLEET_SIZES.slice().sort(function (a, b) { return b - a; });
    if (actualSizes.some(function (value, index) { return value !== expectedSizes[index]; })) {
      return emptyValidationError('fleet-composition', 'Неверный состав флота.');
    }

    // Проверка касания углами и бортами между разными кораблями.
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const current = board.grid[indexOf(x, y)];
        if (!current) continue;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (!inBounds(nx, ny)) continue;
            const neighbour = board.grid[indexOf(nx, ny)];
            if (neighbour && neighbour !== current) {
              return emptyValidationError('touching', 'Корабли не могут касаться друг друга даже углами.');
            }
          }
        }
      }
    }

    return { ok: true, board: board };
  }

  function boardFromLayout(layout) {
    const result = validateLayout(layout);
    return result.ok ? result.board : null;
  }

  function countPlacedCells(board) {
    return board.ships.reduce(function (sum, ship) { return sum + ship.size; }, 0);
  }

  function fleetStatus(board) {
    const total = board.ships.length;
    const sunk = board.ships.filter(function (ship) { return ship.sunk; }).length;
    return {
      total: total,
      sunk: sunk,
      afloat: total - sunk,
      placedCells: countPlacedCells(board)
    };
  }

  function allShipsSunk(board) {
    return board.ships.length === FLEET_SIZES.length &&
      board.ships.every(function (ship) { return ship.sunk; });
  }

  /**
   * Обрабатывает выстрел по собственному полю.
   * Возвращает { ok, result: 'miss'|'hit'|'sunk', sunkCells, gameOver }.
   */
  function registerShot(board, x, y) {
    if (!inBounds(x, y)) {
      return { ok: false, error: 'invalid-coordinates' };
    }
    const idx = indexOf(x, y);
    if (board.shots[idx] !== null) {
      return { ok: false, error: 'already-shot' };
    }

    const ship = getShipAt(board, x, y);
    if (!ship) {
      board.shots[idx] = 'miss';
      return {
        ok: true,
        x: x,
        y: y,
        result: 'miss',
        gameOver: false
      };
    }

    board.shots[idx] = 'hit';
    const shipSunk = ship.cells.every(function (cell) {
      return board.shots[indexOf(cell.x, cell.y)] !== null;
    });

    if (!shipSunk) {
      return {
        ok: true,
        x: x,
        y: y,
        result: 'hit',
        shipId: ship.id,
        gameOver: false
      };
    }

    ship.sunk = true;
    const sunkCells = ship.cells.map(function (cell) {
      board.shots[indexOf(cell.x, cell.y)] = 'sunk';
      return [cell.x, cell.y];
    });

    return {
      ok: true,
      x: x,
      y: y,
      result: 'sunk',
      shipId: ship.id,
      size: ship.size,
      sunkCells: sunkCells,
      gameOver: allShipsSunk(board)
    };
  }

  /**
   * Применяет к полю противника уже известный результат выстрела.
   * Используется стрелявшим игроком после ответа соперника.
   */
  function applyShotResult(board, x, y, result, sunkCells) {
    if (!inBounds(x, y)) return false;
    const idx = indexOf(x, y);
    if (result !== 'miss' && result !== 'hit' && result !== 'sunk') return false;
    if (board.shots[idx] !== null && result !== 'sunk') return false;

    if (result === 'miss') {
      board.shots[idx] = 'miss';
      return true;
    }

    board.shots[idx] = 'hit';

    let cells = sunkCells;
    if (!Array.isArray(cells)) {
      const ship = getShipAt(board, x, y);
      cells = ship ? ship.cells.map(function (cell) { return [cell.x, cell.y]; }) : [];
    }

    if (result === 'sunk') {
      const valid = cells.every(function (pair) {
        return Array.isArray(pair) && inBounds(pair[0], pair[1]);
      });
      if (!valid) return false;
      cells.forEach(function (pair) {
        board.shots[indexOf(pair[0], pair[1])] = 'sunk';
      });
      const ship = getShipAt(board, x, y);
      if (ship) ship.sunk = true;
    }
    return true;
  }

  function randomInt(max, rng) {
    return Math.min(max - 1, Math.floor(rng() * max));
  }

  /**
   * Генерирует случайную корректную расстановку всего флота.
   */
  function randomLayout(rng) {
    const random = typeof rng === 'function' ? rng : Math.random;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const board = createBoard();
      let failed = false;

      for (let s = 0; s < FLEET_SIZES.length; s += 1) {
        const size = FLEET_SIZES[s];
        const variants = [];
        for (let horizontal = 1; horizontal >= 0; horizontal -= 1) {
          if (size === 1 && horizontal === 0) continue;
          for (let y = 0; y < BOARD_SIZE; y += 1) {
            for (let x = 0; x < BOARD_SIZE; x += 1) {
              if (canPlace(board, size, x, y, horizontal)) {
                variants.push({ x: x, y: y, horizontal: Boolean(horizontal) });
              }
            }
          }
        }
        if (!variants.length) {
          failed = true;
          break;
        }
        const pick = variants[randomInt(variants.length, random)];
        placeShip(board, size, pick.x, pick.y, pick.horizontal);
      }

      if (!failed && board.ships.length === FLEET_SIZES.length) return board;
    }
    throw new Error('Не удалось сгенерировать расстановку кораблей.');
  }

  function shotAt(board, x, y) {
    return inBounds(x, y) ? board.shots[indexOf(x, y)] : null;
  }

  return Object.freeze({
    BOARD_SIZE: BOARD_SIZE,
    CELL_COUNT: CELL_COUNT,
    FLEET_SIZES: FLEET_SIZES,
    SHIP_NAMES: SHIP_NAMES,
    indexOf: indexOf,
    inBounds: inBounds,
    coordLabel: coordLabel,
    cellsForShip: cellsForShip,
    createBoard: createBoard,
    canPlace: canPlace,
    placeShip: placeShip,
    removeShip: removeShip,
    undoLastShip: undoLastShip,
    getShipAt: getShipAt,
    serializeLayout: serializeLayout,
    validateLayout: validateLayout,
    boardFromLayout: boardFromLayout,
    countPlacedCells: countPlacedCells,
    fleetStatus: fleetStatus,
    allShipsSunk: allShipsSunk,
    registerShot: registerShot,
    applyShotResult: applyShotResult,
    randomLayout: randomLayout,
    shotAt: shotAt
  });
});
