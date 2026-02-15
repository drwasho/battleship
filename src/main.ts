import './styles.css';
import { SHIP_BY_ID, SHIPS } from './engine/data';
import { SeededRng } from './engine/rng';
import {
  allShipsPlaced,
  canMoveShip,
  clearEphemeral,
  hasWinner,
  key,
  placeShip,
  randomFleetPlacement,
  randomLegalShot,
  randomMovePlan,
  resolveMovement,
  resolveShot,
  shipCells,
} from './engine/rules';
import { createInitialState } from './engine/state';
import type { Coord, GameState, MoveOrder, Orientation, PlayerId, ShipInstance } from './engine/types';
import { BattleScene } from './render/scene';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="layout" id="layout">
    <aside class="panel" id="leftPanel"></aside>
    <main class="main" id="mainView"></main>
    <aside class="panel right" id="rightPanel"></aside>
  </div>
`;

const leftPanel = document.querySelector<HTMLDivElement>('#leftPanel')!;
const rightPanel = document.querySelector<HTMLDivElement>('#rightPanel')!;
const mainView = document.querySelector<HTMLDivElement>('#mainView')!;

const passOverlay = document.createElement('div');
passOverlay.className = 'overlay';
passOverlay.style.display = 'none';
passOverlay.style.position = 'fixed';
passOverlay.style.inset = '0';
passOverlay.innerHTML = `
  <div class="overlay-card">
    <h2>Pass Device</h2>
    <p id="passText"></p>
    <button id="passBtn">Continue</button>
  </div>
`;
document.body.appendChild(passOverlay);

const scene = new BattleScene(mainView);

let game: GameState | null = null;
let rng = new SeededRng(1337);
let activeViewer: PlayerId = 0;
let notice = '';
let noticeKind: 'ok' | 'error' | '' = '';
let placementOrientation: Orientation = 'H';
let movementOrientation: Orientation = 'H';
let selectedPlacementShipUid: string | null = null;
let selectedFiringShipUid: string | null = null;
let selectedMoveShipUid: string | null = null;
let hoverOwn: Coord | undefined;
let hoverTarget: Coord | undefined;
let selectedTargetCell: Coord | undefined;
const plannedMoves: Record<PlayerId, Map<string, MoveOrder>> = { 0: new Map(), 1: new Map() };
let aiBusy = false;
let passCallback: (() => void) | null = null;

function setNotice(text: string, kind: 'ok' | 'error' | '' = ''): void {
  notice = text;
  noticeKind = kind;
}

function clearNotice(): void {
  notice = '';
  noticeKind = '';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestPass(playerId: PlayerId, reason: string, next: () => void): void {
  const passText = passOverlay.querySelector<HTMLParagraphElement>('#passText')!;
  passText.textContent = `${reason}. Hand to ${game?.players[playerId].name} and continue.`;
  passOverlay.style.display = 'flex';
  passCallback = () => {
    passOverlay.style.display = 'none';
    activeViewer = playerId;
    next();
  };
}

passOverlay.querySelector<HTMLButtonElement>('#passBtn')!.onclick = () => {
  passCallback?.();
  passCallback = null;
};

document.addEventListener('keydown', (ev) => {
  if (ev.key.toLowerCase() === 'r') {
    placementOrientation = placementOrientation === 'H' ? 'V' : 'H';
    movementOrientation = movementOrientation === 'H' ? 'V' : 'H';
    render();
  }
});

scene.getCanvas().addEventListener('mousemove', (ev) => {
  const hit = scene.pick(ev.clientX, ev.clientY);
  hoverOwn = undefined;
  hoverTarget = undefined;
  if (hit?.board === 'own') {
    hoverOwn = hit.cell;
  }
  if (hit?.board === 'target') {
    hoverTarget = hit.cell;
  }
  renderSceneOnly();
});

scene.getCanvas().addEventListener('click', async (ev) => {
  const hit = scene.pick(ev.clientX, ev.clientY);
  if (!game || !hit || passOverlay.style.display !== 'none') {
    return;
  }

  if ((game.phase === 'placement_p1' && activeViewer === 0) || (game.phase === 'placement_p2' && activeViewer === 1)) {
    if (hit.board !== 'own' || !selectedPlacementShipUid) {
      return;
    }
    const player = game.players[activeViewer];
    const ok = placeShip(player, selectedPlacementShipUid, hit.cell, placementOrientation);
    if (!ok) {
      setNotice('Invalid placement: overlap or out of bounds.', 'error');
    } else {
      setNotice('Ship placed.', 'ok');
      const nextUnplaced = player.ships.find((s) => !s.placed);
      selectedPlacementShipUid = nextUnplaced?.uid ?? null;
      if (allShipsPlaced(player)) {
        await onPlacementFinished(activeViewer);
      }
    }
    render();
    return;
  }

  if ((game.phase === 'firing_p1' && activeViewer === 0) || (game.phase === 'firing_p2' && activeViewer === 1)) {
    if (hit.board !== 'target' || !selectedFiringShipUid) {
      return;
    }
    selectedTargetCell = hit.cell;
    await doHumanFire(activeViewer, selectedFiringShipUid, hit.cell);
    render();
    return;
  }

  if ((game.phase === 'movement_p1' && activeViewer === 0) || (game.phase === 'movement_p2' && activeViewer === 1)) {
    if (hit.board !== 'own' || !selectedMoveShipUid) {
      return;
    }
    const order: MoveOrder = { shipUid: selectedMoveShipUid, to: hit.cell, orientation: movementOrientation };
    const valid = canMoveShip(game, activeViewer, order);
    if (!valid) {
      setNotice('Illegal move. Choose a different destination/orientation.', 'error');
    } else {
      plannedMoves[activeViewer].set(selectedMoveShipUid, order);
      setNotice('Move planned.', 'ok');
      const next = game.players[activeViewer].ships.find((s) => !s.sunk && s.placed && !plannedMoves[activeViewer].has(s.uid));
      selectedMoveShipUid = next?.uid ?? selectedMoveShipUid;
      await maybeFinalizeMovementPhase();
    }
    render();
  }
});

function startMenu(): void {
  game = null;
  activeViewer = 0;
  clearNotice();
  leftPanel.innerHTML = `
    <div class="section">
      <h1>Moving Battleships</h1>
      <p>3D naval duel with alternating fire and simultaneous movement.</p>
      <div class="menu">
        <button id="start1p">1 Player vs Easy AI</button>
        <button id="start2p">2 Player Hotseat</button>
      </div>
    </div>
    <div class="section stat">
      Controls: R rotates during placement/movement. Click tiles to place, fire, and set move destinations.
    </div>
  `;
  rightPanel.innerHTML = '';
  (document.querySelector('#start1p') as HTMLButtonElement).onclick = () => startGame('1p');
  (document.querySelector('#start2p') as HTMLButtonElement).onclick = () => startGame('2p');

  scene.renderState({
    ownShips: [],
    ownShipHpPercent: new Map(),
    targetMisses: new Set(),
    targetEphemeralHits: new Set(),
    previewCells: [],
    previewColor: 0x66c9f0,
  });
}

function startGame(mode: '1p' | '2p'): void {
  game = createInitialState(mode);
  rng = new SeededRng(90210);
  activeViewer = 0;
  placementOrientation = 'H';
  movementOrientation = 'H';
  selectedPlacementShipUid = game.players[0].ships[0].uid;
  selectedFiringShipUid = null;
  selectedMoveShipUid = null;
  plannedMoves[0].clear();
  plannedMoves[1].clear();
  clearNotice();
  render();
}

async function onPlacementFinished(playerId: PlayerId): Promise<void> {
  if (!game) {
    return;
  }
  if (playerId === 0) {
    if (game.mode === '1p') {
      randomFleetPlacement(game.players[1], rng);
      game.phase = 'firing_p1';
      activeViewer = 0;
      selectedFiringShipUid = game.players[0].ships.find((s) => !s.sunk)!.uid;
      setNotice('Your fleet is deployed. Begin firing.', 'ok');
      render();
    } else {
      game.phase = 'placement_p2';
      selectedPlacementShipUid = game.players[1].ships[0].uid;
      requestPass(1, 'Placement complete for Player 1', () => {
        clearNotice();
        render();
      });
    }
    return;
  }

  game.phase = 'firing_p1';
  selectedFiringShipUid = game.players[0].ships.find((s) => !s.sunk)!.uid;
  requestPass(0, 'Both fleets deployed', () => {
    clearNotice();
    render();
  });
}

function currentPlayerForPhase(): PlayerId | null {
  if (!game) {
    return null;
  }
  if (game.phase.endsWith('p1')) {
    return 0;
  }
  if (game.phase.endsWith('p2')) {
    return 1;
  }
  return null;
}

function getPreviewCells(): Coord[] {
  if (!game) {
    return [];
  }
  if ((game.phase === 'placement_p1' || game.phase === 'placement_p2') && hoverOwn && selectedPlacementShipUid) {
    const player = game.players[activeViewer];
    const ship = player.ships.find((s) => s.uid === selectedPlacementShipUid);
    if (!ship) {
      return [];
    }
    const copy: ShipInstance = { ...ship, anchor: hoverOwn, orientation: placementOrientation };
    return shipCells(copy);
  }
  if ((game.phase === 'movement_p1' || game.phase === 'movement_p2') && hoverOwn && selectedMoveShipUid) {
    const player = game.players[activeViewer];
    const ship = player.ships.find((s) => s.uid === selectedMoveShipUid);
    if (!ship) {
      return [];
    }
    const copy: ShipInstance = { ...ship, anchor: hoverOwn, orientation: movementOrientation };
    return shipCells(copy);
  }
  return [];
}

function renderSceneOnly(): void {
  if (!game) {
    return;
  }
  const me = game.players[activeViewer];
  const hpMap = new Map<string, number>();
  for (const s of me.ships) {
    hpMap.set(s.uid, s.hp / SHIP_BY_ID[s.typeId].maxHp);
  }

  scene.renderState({
    ownShips: me.ships,
    ownShipHpPercent: hpMap,
    targetMisses: me.misses,
    targetEphemeralHits: me.ephemeralHits,
    previewCells: getPreviewCells(),
    previewColor: 0x69c7ff,
    selectedOwnCell: hoverOwn,
    selectedTargetCell: hoverTarget,
  });
}

function render(): void {
  if (!game) {
    return startMenu();
  }

  const me = game.players[activeViewer];
  const enemy = game.players[activeViewer === 0 ? 1 : 0];
  const phasePlayer = currentPlayerForPhase();

  const placementMode = game.phase === 'placement_p1' || game.phase === 'placement_p2';
  const firingMode = game.phase === 'firing_p1' || game.phase === 'firing_p2';
  const moveMode = game.phase === 'movement_p1' || game.phase === 'movement_p2';

  leftPanel.innerHTML = `
    <div class="section">
      <h1>Moving Battleships</h1>
      <p class="stat">Round ${game.round} • Phase: ${game.phase.replace('_', ' ')}</p>
      <p class="stat">Perspective: ${me.name}</p>
    </div>

    <div class="section">
      <h2>Controls</h2>
      <div class="row">
        <button id="rotateBtn">Rotate (R): ${placementMode ? placementOrientation : movementOrientation}</button>
        <button id="menuBtn">Back to Menu</button>
      </div>
      <p class="notice ${noticeKind}">${notice}</p>
    </div>

    <div class="section" id="actionSection"></div>
  `;

  rightPanel.innerHTML = `
    <div class="section">
      <h2>Destroyed Ships</h2>
      <p class="stat">P1 sank: ${game.players[0].destroyedEnemyTypes.length ? game.players[0].destroyedEnemyTypes.join(', ') : 'none'}</p>
      <p class="stat">P2 sank: ${game.players[1].destroyedEnemyTypes.length ? game.players[1].destroyedEnemyTypes.join(', ') : 'none'}</p>
    </div>
    <div class="section">
      <h2>Fleet Status (${me.name})</h2>
      ${me.ships
        .map((s) => {
          const t = SHIP_BY_ID[s.typeId];
          return `<div class="list-item ${s.sunk ? 'dead' : ''}">
            <span class="ship-icon" style="background:#9daebc"></span>${t.name} (size ${t.size})<br/>
            <span class="stat">HP ${s.hp}/${t.maxHp} • move ${t.move} • guns ${t.guns.map((g) => `${g.count}x${g.type}`).join(' + ')}</span>
          </div>`;
        })
        .join('')}
    </div>
    <div class="section">
      <h2>Enemy Fleet Remaining</h2>
      <p class="stat">${enemy.ships.filter((s) => !s.sunk).length} ships alive</p>
    </div>
  `;

  const actionSection = document.querySelector<HTMLDivElement>('#actionSection')!;
  if (game.phase === 'game_over') {
    const winner = game.players[game.winner!].name;
    actionSection.innerHTML = `
      <h2>Game Over</h2>
      <p>${winner} wins.</p>
      <button id="restartBtn">Return to Menu</button>
    `;
    (document.querySelector('#restartBtn') as HTMLButtonElement).onclick = () => startMenu();
  } else if (placementMode) {
    const ships = me.ships;
    actionSection.innerHTML = `
      <h2>Placement</h2>
      <p class="stat">Select ship, hover left grid, click to place.</p>
      ${ships
        .map((s) => {
          const t = SHIP_BY_ID[s.typeId];
          return `<button data-ship="${s.uid}" class="${selectedPlacementShipUid === s.uid ? 'selected' : ''}" ${s.placed ? 'disabled' : ''}>${t.name} (${t.size})</button>`;
        })
        .join('')}
    `;

    actionSection.querySelectorAll('button[data-ship]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedPlacementShipUid = (btn as HTMLButtonElement).dataset.ship!;
        render();
      });
    });
  } else if (firingMode) {
    const acting = phasePlayer!;
    const canAct = acting === activeViewer;
    actionSection.innerHTML = `
      <h2>Firing Step</h2>
      <p class="stat">Choose one of your surviving ships, then click a target cell on right grid.</p>
      ${me.ships
        .filter((s) => !s.sunk)
        .map((s) => `<button data-fire="${s.uid}" class="${selectedFiringShipUid === s.uid ? 'selected' : ''}" ${canAct ? '' : 'disabled'}>${SHIP_BY_ID[s.typeId].name}</button>`)
        .join('')}
      <p class="stat">Selected target: ${selectedTargetCell ? `${selectedTargetCell.x},${selectedTargetCell.y}` : 'none'}</p>
    `;
    actionSection.querySelectorAll('button[data-fire]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedFiringShipUid = (btn as HTMLButtonElement).dataset.fire!;
        render();
      });
    });
  } else if (moveMode) {
    const canAct = phasePlayer === activeViewer;
    const map = plannedMoves[activeViewer];
    actionSection.innerHTML = `
      <h2>Movement Planning</h2>
      <p class="stat">Select ship, click destination on left grid, optional rotate. Use Skip when needed.</p>
      ${me.ships
        .filter((s) => !s.sunk)
        .map((s) => {
          const o = map.get(s.uid);
          const summary = o ? (o.skip ? 'skip' : `to ${o.to.x},${o.to.y} ${o.orientation}`) : 'pending';
          return `<div class="list-item">
            <button data-move="${s.uid}" class="${selectedMoveShipUid === s.uid ? 'selected' : ''}" ${canAct ? '' : 'disabled'}>${SHIP_BY_ID[s.typeId].name}</button>
            <div class="stat">${summary}</div>
          </div>`;
        })
        .join('')}
      <div class="row">
        <button id="skipShip" ${canAct ? '' : 'disabled'}>Skip Selected Ship</button>
        <button id="clearMoves" ${canAct ? '' : 'disabled'}>Clear My Plans</button>
      </div>
    `;

    actionSection.querySelectorAll('button[data-move]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedMoveShipUid = (btn as HTMLButtonElement).dataset.move!;
        render();
      });
    });

    (document.querySelector('#skipShip') as HTMLButtonElement).onclick = async () => {
      if (!selectedMoveShipUid) {
        return;
      }
      const ship = me.ships.find((s) => s.uid === selectedMoveShipUid)!;
      plannedMoves[activeViewer].set(selectedMoveShipUid, {
        shipUid: selectedMoveShipUid,
        to: ship.anchor,
        orientation: ship.orientation,
        skip: true,
      });
      setNotice('Ship marked skip.', 'ok');
      await maybeFinalizeMovementPhase();
      render();
    };

    (document.querySelector('#clearMoves') as HTMLButtonElement).onclick = () => {
      plannedMoves[activeViewer].clear();
      setNotice('Movement plans cleared.', 'ok');
      render();
    };
  }

  (document.querySelector('#rotateBtn') as HTMLButtonElement).onclick = () => {
    placementOrientation = placementOrientation === 'H' ? 'V' : 'H';
    movementOrientation = movementOrientation === 'H' ? 'V' : 'H';
    render();
  };
  (document.querySelector('#menuBtn') as HTMLButtonElement).onclick = () => startMenu();

  renderSceneOnly();
  maybeRunAI().catch(console.error);
}

async function doHumanFire(playerId: PlayerId, shipUid: string, target: Coord): Promise<void> {
  if (!game) {
    return;
  }
  const result = resolveShot(game, playerId, shipUid, target);
  if (!result) {
    setNotice('Invalid shot.', 'error');
    return;
  }

  const ship = game.players[playerId].ships.find((s) => s.uid === shipUid);
  const gunCount = SHIP_BY_ID[ship!.typeId].guns.reduce((acc, g) => acc + g.count, 0);
  scene.animateShot(ship, target, gunCount, result.hit, () => {
    if (result.sunkShipUid) {
      scene.sinkShip(result.sunkShipUid);
    }
  });

  setNotice(result.hit ? `Hit for ${result.damage} damage.` : 'Miss.', result.hit ? 'ok' : '');
  await wait(650);

  const winner = hasWinner(game);
  if (winner !== undefined) {
    game.phase = 'game_over';
    game.winner = winner;
    render();
    return;
  }

  if (playerId === 0) {
    game.phase = 'firing_p2';
    selectedFiringShipUid = game.players[1].ships.find((s) => !s.sunk)!.uid;
    if (game.mode === '2p') {
      requestPass(1, 'Player 1 firing complete', () => render());
    }
  } else {
    game.phase = 'movement_p1';
    selectedMoveShipUid = game.players[0].ships.find((s) => !s.sunk)!.uid;
    plannedMoves[0].clear();
    plannedMoves[1].clear();
    if (game.mode === '2p') {
      requestPass(0, 'Firing phase complete', () => render());
    }
  }
}

async function maybeFinalizeMovementPhase(): Promise<void> {
  if (!game) {
    return;
  }
  const pid = currentPlayerForPhase();
  if (pid === null) {
    return;
  }

  const needed = game.players[pid].ships.filter((s) => !s.sunk && s.placed).map((s) => s.uid);
  const done = needed.every((uid) => plannedMoves[pid].has(uid));
  if (!done) {
    return;
  }

  if (pid === 0) {
    game.phase = 'movement_p2';
    selectedMoveShipUid = game.players[1].ships.find((s) => !s.sunk)!.uid;
    if (game.mode === '2p') {
      requestPass(1, 'Player 1 movement planned', () => render());
    }
  } else {
    await resolveMovementPhase();
  }
}

async function resolveMovementPhase(): Promise<void> {
  if (!game) {
    return;
  }

  if (game.mode === '1p') {
    let tries = 0;
    while (tries < 6) {
      const result = resolveMovement(game, [...plannedMoves[0].values()], [...plannedMoves[1].values()]);
      const aiRejected = result.rejected.filter((uid) => uid.startsWith('1-'));
      if (aiRejected.length === 0) {
        if (result.rejected.length) {
          setNotice(`Some movement rejected (${result.rejected.join(', ')}).`, 'error');
        }
        break;
      }
      plannedMoves[1].clear();
      for (const o of randomMovePlan(game, 1, rng)) {
        plannedMoves[1].set(o.shipUid, o);
      }
      tries += 1;
    }
  } else {
    const result = resolveMovement(game, [...plannedMoves[0].values()], [...plannedMoves[1].values()]);
    if (result.rejected.length) {
      setNotice(`Rejected moves: ${result.rejected.join(', ')}`, 'error');
    } else {
      setNotice('Movement resolved.', 'ok');
    }
  }

  clearEphemeral(game);
  game.round += 1;
  game.phase = 'firing_p1';
  selectedFiringShipUid = game.players[0].ships.find((s) => !s.sunk)?.uid ?? null;
  selectedMoveShipUid = null;
  plannedMoves[0].clear();
  plannedMoves[1].clear();

  if (game.mode === '2p') {
    requestPass(0, 'Movement resolved', () => render());
  }
  render();
}

async function maybeRunAI(): Promise<void> {
  if (!game || aiBusy || passOverlay.style.display !== 'none') {
    return;
  }

  if (game.mode !== '1p') {
    return;
  }

  if (game.phase === 'firing_p2') {
    aiBusy = true;
    await wait(500);
    const shot = randomLegalShot(game, 1, rng);
    await doHumanFire(1, shot.shipUid, shot.target);
    aiBusy = false;
    return;
  }

  if (game.phase === 'movement_p2') {
    aiBusy = true;
    plannedMoves[1].clear();
    for (const o of randomMovePlan(game, 1, rng)) {
      plannedMoves[1].set(o.shipUid, o);
    }
    await wait(400);
    await resolveMovementPhase();
    aiBusy = false;
  }
}

startMenu();
