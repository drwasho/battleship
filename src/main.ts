import './styles.css';
import { SHIP_BY_ID, SHIPS } from './engine/data';
import { SeededRng } from './engine/rng';
import {
  allShipsPlaced,
  canShipFire,
  canMoveShip,
  clearEphemeral,
  hasWinner,
  hasUnfiredShips,
  key,
  nextFiringPlayer,
  placeShip,
  randomFleetPlacement,
  randomLegalShot,
  randomMovePlan,
  resetFiringRound,
  resolveMovement,
  computeSalvoTargets,
  resolveSalvo,
  shipCells,
} from './engine/rules';
import { createInitialState } from './engine/state';
import type { Coord, GameState, MoveOrder, Orientation, PlayerId, ShipInstance, ShipTypeId } from './engine/types';
import { sfx } from './audio/sfx';
import { OnlineClient } from './online/client';
import type { RoomPublicInfo, RoomState, Role } from './online/types';
import { BattleScene } from './render/scene';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="layout" id="layout">
    <aside class="panel" id="leftPanel"></aside>
    <main class="main" id="mainView">
      <div class="topbar" id="topbar"></div>
    </main>
    <aside class="panel right" id="rightPanel"></aside>
  </div>
`;

const leftPanel = document.querySelector<HTMLDivElement>('#leftPanel')!;
const rightPanel = document.querySelector<HTMLDivElement>('#rightPanel')!;
const mainView = document.querySelector<HTMLDivElement>('#mainView')!;
const topbar = document.querySelector<HTMLDivElement>('#topbar')!;

const mapLabels = document.createElement('div');
mapLabels.className = 'map-labels';
mapLabels.innerHTML = `
  <div class="map-label map-label-own">Your fleet</div>
  <div class="map-label map-label-target">Targeting radar</div>
`;
mainView.appendChild(mapLabels);

const phasePrompt = document.createElement('div');
phasePrompt.className = 'phase-prompt';
mainView.appendChild(phasePrompt);

function updateMapLabelPositions(): void {
  const left = mapLabels.children[0] as HTMLElement | undefined;
  const right = mapLabels.children[1] as HTMLElement | undefined;
  if (!left || !right) {
    return;
  }

  const mainRect = mainView.getBoundingClientRect();
  const canvasRect = scene.getCanvasRect();

  // getBoardLabelScreen gives pixel coords relative to the canvas.
  const own = scene.getBoardLabelScreen('own');
  const target = scene.getBoardLabelScreen('target');

  const toMain = (p: { x: number; y: number }) => ({
    x: canvasRect.left - mainRect.left + p.x,
    y: canvasRect.top - mainRect.top + p.y,
  });

  const ownPx = toMain(own);
  const targetPx = toMain(target);

  left.style.left = `${ownPx.x - left.offsetWidth / 2}px`;
  right.style.left = `${targetPx.x - right.offsetWidth / 2}px`;

  left.style.top = `${ownPx.y}px`;
  right.style.top = `${targetPx.y}px`;
}

window.addEventListener('resize', () => updateMapLabelPositions());
setTimeout(updateMapLabelPositions, 0);

let soundEnabled = true;
let soundVolume = 0.7;

let audioPrimed = false;
async function primeAudio(): Promise<void> {
  if (audioPrimed || !soundEnabled) {
    return;
  }
  audioPrimed = true;
  await sfx.enable();
  sfx.setVolume(soundVolume);
}

document.addEventListener('pointerdown', () => {
  void primeAudio();
}, { once: true });
document.addEventListener('keydown', () => {
  void primeAudio();
}, { once: true });

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

type Screen = 'menu' | 'local' | 'online';
let screen: Screen = 'menu';

const SERVER_URL = (import.meta as any).env?.VITE_SERVER_URL as string | undefined;

type OnlineState = {
  sessionId: string;
  name: string;
  connected: boolean;
  rooms: RoomPublicInfo[];
  room: RoomState | null;
  role: Role;
  seat: 'p1' | 'p2' | 'spectator' | null;
  notice: string;
};

let online: OnlineState | null = null;
let onlineClient: OnlineClient | null = null;
let rng = new SeededRng(1337);
let activeViewer: PlayerId = 0;
let notice = '';
let noticeKind: 'ok' | 'error' | '' = '';
let placementOrientation: Orientation = 'H';
let movementOrientation: Orientation = 'H';
let targetingOrientation: Orientation = 'H';
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
  if (ev.key.toLowerCase() !== 'r') {
    return;
  }
  const phase = game?.phase;
  if (phase === 'firing_p1' || phase === 'firing_p2') {
    targetingOrientation = targetingOrientation === 'H' ? 'V' : 'H';
  } else if (phase === 'movement_p1' || phase === 'movement_p2') {
    movementOrientation = movementOrientation === 'H' ? 'V' : 'H';
  } else {
    // placement (or menu/default)
    placementOrientation = placementOrientation === 'H' ? 'V' : 'H';
  }
  render();
});

// Use a window-level pointermove so hover works even if the last click was on a
// non-intersecting area (between boards) and the canvas doesn't receive move events
// due to focus/pointer quirks.
window.addEventListener('pointermove', (ev) => {
  const canvas = scene.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const inside = ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
  if (!inside) {
    if (hoverOwn || hoverTarget) {
      hoverOwn = undefined;
      hoverTarget = undefined;
      renderSceneOnly();
    }
    return;
  }

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
      if (soundEnabled) {
        void primeAudio();
        sfx.play('move', 0.75);
      }
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
  screen = 'menu';
  activeViewer = 0;
  topbar.innerHTML = '';
  phasePrompt.textContent = '';
  phasePrompt.style.display = 'none';
  clearNotice();
  leftPanel.innerHTML = `
    <div class="section">
      <h1>Moving Battleships</h1>
      <p>3D naval duel with alternating fire and simultaneous movement.</p>
      <div class="menu">
        <button id="start1p">1 Player vs Easy AI</button>
        <button id="start2p">2 Player Hotseat</button>
        <button id="startOnline">Online Multiplayer (Lobby)</button>
      </div>
    </div>
    <div class="section stat">
      Controls: R rotates during placement/movement. Click tiles to place, fire, and set move destinations.
    </div>
  `;
  rightPanel.innerHTML = '';
  (document.querySelector('#start1p') as HTMLButtonElement).onclick = () => startGame('1p');
  (document.querySelector('#start2p') as HTMLButtonElement).onclick = () => startGame('2p');
  (document.querySelector('#startOnline') as HTMLButtonElement).onclick = () => startOnline();

  scene.renderState({
    ownShips: [],
    targetMisses: new Set(),
    targetEphemeralHits: new Set(),
    ephemeralImpactMarkers: [],
    previewCells: [],
    previewColor: 0x66c9f0,
  });
}

function startGame(mode: '1p' | '2p'): void {
  screen = 'local';
  game = createInitialState(mode);
  rng = new SeededRng(90210);
  activeViewer = 0;
  placementOrientation = 'H';
  movementOrientation = 'H';
  targetingOrientation = 'H';
  selectedPlacementShipUid = game.players[0].ships[0]!.uid;
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
      resetFiringRound(game);
      game.phase = 'firing_p1';
      activeViewer = 0;
      selectedFiringShipUid = pickDefaultFiringShip(0);
      setNotice('Your fleet is deployed. Begin firing round 1.', 'ok');
      render();
    } else {
      game.phase = 'placement_p2';
      selectedPlacementShipUid = game.players[1].ships[0]!.uid;
      requestPass(1, 'Placement complete for Player 1', () => {
        clearNotice();
        render();
      });
    }
    return;
  }

  resetFiringRound(game);
  game.phase = 'firing_p1';
  selectedFiringShipUid = pickDefaultFiringShip(0);
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

function currentActionLabel(): string {
  if (!game) {
    return '';
  }
  if (game.phase.startsWith('placement_')) {
    return 'placing';
  }
  if (game.phase.startsWith('firing_')) {
    return 'firing';
  }
  if (game.phase.startsWith('movement_')) {
    return 'moving';
  }
  return '';
}

function displayPlayerLabel(playerId: PlayerId): string {
  if (!game) {
    return '';
  }
  if (game.mode === '1p') {
    return playerId === 0 ? 'You' : 'Computer';
  }
  return game.players[playerId].name;
}

function shipNameFromUid(uid: string): string {
  const parts = uid.split('-');
  const maybeType = parts.slice(1).join('-') as ShipTypeId;
  return SHIP_BY_ID[maybeType]?.name ?? uid;
}

function phasePromptText(): string {
  if (!game) {
    return '';
  }

  const phase = game.phase;
  const pid = currentPlayerForPhase();
  const isMyTurn = pid !== null && pid === activeViewer;

  if (phase.startsWith('placement_')) {
    return isMyTurn ? 'Place your ships: select a ship, then click “Your fleet”.' : 'Waiting for other player to place ships…';
  }

  if (phase.startsWith('firing_')) {
    return isMyTurn ? 'Fire: select a ship, then click “Targeting radar” (R rotates).' : 'Waiting for other player to fire…';
  }

  if (phase.startsWith('movement_')) {
    if (!isMyTurn) {
      return 'Waiting for other player to plan movement…';
    }
    const needed = game.players[activeViewer].ships.filter((s) => s.placed && !s.sunk).map((s) => s.uid);
    const done = needed.every((uid) => plannedMoves[activeViewer].has(uid));
    return done ? 'Movement planned. Waiting…' : 'Plan movement: select a ship, then click its destination on “Your fleet”.';
  }

  if (phase === 'game_over') {
    return 'Game over.';
  }

  return '';
}

function turnIndicatorText(): string {
  if (!game || game.phase === 'game_over') {
    return '';
  }
  const player = currentPlayerForPhase();
  const action = currentActionLabel();
  if (player === null || !action) {
    return '';
  }
  return `${displayPlayerLabel(player)} ${action}`;
}

function pickDefaultFiringShip(playerId: PlayerId): string | null {
  if (!game) {
    return null;
  }
  const state = game;
  return state.players[playerId].ships.find((s) => canShipFire(state, playerId, s.uid))?.uid ?? null;
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
    const ship = player.ships.find((s) => s.uid === selectedMoveShipUid && !s.sunk && s.placed);
    if (!ship) {
      return [];
    }
    const copy: ShipInstance = { ...ship, anchor: hoverOwn, orientation: movementOrientation };
    return shipCells(copy);
  }
  // Firing preview: show which squares will be hit by this ship's salvo.
  if ((game.phase === 'firing_p1' || game.phase === 'firing_p2') && hoverTarget && selectedFiringShipUid) {
    const ship = game.players[activeViewer].ships.find((s) => s.uid === selectedFiringShipUid && s.placed && !s.sunk);
    if (!ship) {
      return [];
    }
    const k = SHIP_BY_ID[ship.typeId].gunCount;
    return computeSalvoTargets(hoverTarget, targetingOrientation, k);
  }
  return [];
}

function getMovementPreviewValidity(): boolean | null {
  if (!game || !hoverOwn || !selectedMoveShipUid) {
    return null;
  }
  if (game.phase !== 'movement_p1' && game.phase !== 'movement_p2') {
    return null;
  }
  return canMoveShip(game, activeViewer, { shipUid: selectedMoveShipUid, to: hoverOwn, orientation: movementOrientation });
}

function renderSceneOnly(): void {
  if (!game) {
    return;
  }
  const me = game.players[activeViewer];

  const moveMode = game.phase === 'movement_p1' || game.phase === 'movement_p2';
  const movementPreviewValidity = getMovementPreviewValidity();
  const firingReadyShipUids = new Set<string>();
  const firingSpentShipUids = new Set<string>();
  if (game.phase === 'firing_p1' || game.phase === 'firing_p2') {
    for (const ship of me.ships) {
      if (!ship.placed || ship.sunk) {
        continue;
      }
      if (canShipFire(game, activeViewer, ship.uid)) {
        firingReadyShipUids.add(ship.uid);
      } else {
        firingSpentShipUids.add(ship.uid);
      }
    }
  }
  let ownShipsForScene = me.ships;
  // During movement planning, preview *this viewer's* planned destinations by temporarily
  // applying orders to their ships (purely visual; engine state updates only on resolveMovement).
  // Important: keep showing the preview even after the phase advances (e.g. P1 finishes planning
  // and we switch to movement_p2 while still on P1's view / pass overlay).
  if (moveMode) {
    const orders = plannedMoves[activeViewer];
    if (orders.size) {
      ownShipsForScene = me.ships.map((s) => {
        const o = orders.get(s.uid);
        if (!o || !s.placed || s.sunk) {
          return s;
        }
        return { ...s, anchor: o.to, orientation: o.orientation };
      });
    }
  }

  const firingMode = game.phase === 'firing_p1' || game.phase === 'firing_p2';
  const sceneState: Parameters<typeof scene.renderState>[0] = {
    ownShips: ownShipsForScene,
    targetMisses: me.misses,
    targetEphemeralHits: me.ephemeralHits,
    ephemeralImpactMarkers: me.ephemeralImpactMarkers,
    firingReadyShipUids,
    firingSpentShipUids,
    previewCells: getPreviewCells(),
    previewBoard: firingMode ? 'target' : 'own',
    previewColor:
      movementPreviewValidity === null ? 0x85dcff : movementPreviewValidity ? 0x6dff9b : 0xff6d6d,
    pulseShipUid: moveMode ? selectedMoveShipUid : null,
  };
  // Don't show selection "donuts" during firing — the salvo preview highlight is enough.
  if (!firingMode) {
    if (hoverOwn) {
      sceneState.selectedOwnCell = hoverOwn;
    }
    if (hoverTarget) {
      sceneState.selectedTargetCell = hoverTarget;
    }
  }
  scene.renderState(sceneState);
  updateMapLabelPositions();
}

function render(): void {
  if (!game) {
    return startMenu();
  }

  const me = game.players[activeViewer];
  const enemy = game.players[activeViewer === 0 ? 1 : 0];
  const phasePlayer = currentPlayerForPhase();

  const state = game; // non-null in render()
  const placementMode = state.phase === 'placement_p1' || state.phase === 'placement_p2';
  const firingMode = state.phase === 'firing_p1' || state.phase === 'firing_p2';
  const moveMode = state.phase === 'movement_p1' || state.phase === 'movement_p2';
  const turnIndicator = turnIndicatorText();
  const phasePretty = game.phase.replace('_', ' ');
  topbar.innerHTML = `<div class="topbar-inner"><span class="topbar-title">${turnIndicator || ''}</span><span class="topbar-sub">Round ${game.round} • ${phasePretty}</span></div>`;
  phasePrompt.textContent = phasePromptText();
  phasePrompt.style.display = phasePrompt.textContent ? 'block' : 'none';
  if (firingMode && (!selectedFiringShipUid || !canShipFire(state, activeViewer, selectedFiringShipUid))) {
    selectedFiringShipUid = pickDefaultFiringShip(activeViewer);
  }

  leftPanel.innerHTML = `
    <div class="section">
      <h1>Moving Battleships</h1>
      <p class="stat">Perspective: ${me.name}</p>
    </div>

    <div class="section">
      <h2>Controls</h2>
      <div class="row">
        <button id="rotateBtn">Rotate (R): ${placementMode ? placementOrientation : moveMode ? movementOrientation : targetingOrientation}</button>
        <button id="menuBtn">Back to Menu</button>
      </div>
      <div class="row" style="margin-top:8px; gap:8px; align-items:center;">
        <button id="soundBtn">Sound: ${soundEnabled ? 'On' : 'Off'}</button>
        <label class="stat" style="display:flex; align-items:center; gap:6px;">Vol
          <input id="soundVol" type="range" min="0" max="1" step="0.05" value="${soundVolume}" style="width:120px;" />
        </label>
      </div>
      <p class="notice ${noticeKind}">${notice}</p>
    </div>

    <div class="section" id="actionSection"></div>
  `;

  rightPanel.innerHTML = `
    <div class="section">
      <h2>Destroyed Ships</h2>
      <p class="stat">${game.mode === '1p' ? 'You' : me.name} sank: ${
        me.destroyedEnemyShipUids.length
          ? me.destroyedEnemyShipUids.map((uid) => shipNameFromUid(uid)).join(', ')
          : 'none'
      }</p>
      <p class="stat">${game.mode === '1p' ? 'Computer' : enemy.name} sank: ${
        enemy.destroyedEnemyShipUids.length
          ? enemy.destroyedEnemyShipUids.map((uid) => shipNameFromUid(uid)).join(', ')
          : 'none'
      }</p>
    </div>
    <div class="section">
      <h2>Fleet Status (${me.name})</h2>
      ${me.ships
        .map((s) => {
          const t = SHIP_BY_ID[s.typeId];
          const firedClass =
            firingMode && s.placed && !s.sunk ? (canShipFire(state, activeViewer, s.uid) ? 'ready-to-fire' : 'spent-ship') : '';
          return `<div class="list-item ${s.sunk ? 'dead' : ''} ${firedClass}">
            <span class="ship-icon" style="background:#9daebc"></span>${t.name} (size ${t.size})<br/>
            <span class="stat">Size ${t.size} • move ${t.move} • guns ${t.gunCount}</span>
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
    const state = game;
    const unfiredShips = me.ships.filter((s) => canShipFire(state, activeViewer, s.uid));
    const firedCount = me.ships.filter((s) => !s.sunk && s.placed).length - unfiredShips.length;
    const selectedShip =
      selectedFiringShipUid ? me.ships.find((s) => s.uid === selectedFiringShipUid && s.placed && !s.sunk) : undefined;
    const selectedShipCard = selectedShip
      ? (() => {
          const t = SHIP_BY_ID[selectedShip.typeId];
          const gunList = `${t.gunCount}`;
          const firedLabel = canShipFire(state, activeViewer, selectedShip.uid) ? 'No' : 'Yes';
          const shipName = game.mode === '1p' ? `Your ${t.name}` : t.name;
          return `
            <div class="selected-ship-card">
              <p class="stat selected-ship-title">Selected Ship</p>
              <p><strong>${shipName}</strong></p>
              <p class="stat">Size: ${t.size} • Move: ${t.move} • Guns: ${t.gunCount}</p>
              <p class="stat">Gun count: ${gunList}</p>
              <p class="stat">Fired this round: ${firedLabel}</p>
            </div>
          `;
        })()
      : '';
    actionSection.innerHTML = `
      <h2>Firing Round</h2>
      <p class="stat">Pick a surviving ship that has not fired this round, then click a target cell on the right grid.</p>
      <p class="stat">Your ships fired this round: ${firedCount}/${me.ships.filter((s) => !s.sunk && s.placed).length}</p>
      ${me.ships
        .filter((s) => !s.sunk && s.placed)
        .map((s) => {
          const ready = canShipFire(state, activeViewer, s.uid);
          const stateClass = ready ? 'ready-to-fire' : 'spent-ship';
          return `<button data-fire="${s.uid}" class="${selectedFiringShipUid === s.uid ? 'selected' : ''} ${stateClass}" ${canAct && ready ? '' : 'disabled'}>${SHIP_BY_ID[s.typeId].name}${ready ? '' : ' (fired)'}</button>`;
        })
        .join('')}
      ${selectedShipCard}
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
    const selectedShip = selectedMoveShipUid ? me.ships.find((s) => s.uid === selectedMoveShipUid && !s.sunk && s.placed) : undefined;
    const maxMove = selectedShip ? SHIP_BY_ID[selectedShip.typeId].move : undefined;
    const previewDistance = selectedShip && hoverOwn ? Math.abs(selectedShip.anchor.x - hoverOwn.x) + Math.abs(selectedShip.anchor.y - hoverOwn.y) : undefined;
    const previewLegal = getMovementPreviewValidity();
    actionSection.innerHTML = `
      <h2>Movement Planning</h2>
      <p class="stat">Select ship, click destination on left grid, optional rotate. Green preview is legal, red is illegal.</p>
      <p class="stat">Max move: ${maxMove ?? '-'}${previewDistance !== undefined ? ` • Preview distance: ${previewDistance}${previewLegal === null ? '' : previewLegal ? ' (legal)' : ' (illegal)'}` : ''}</p>
      ${me.ships
        .filter((s) => !s.sunk && s.placed)
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
      const ship = me.ships.find((s) => s.uid === selectedMoveShipUid && !s.sunk && s.placed);
      if (!ship) {
        setNotice('Cannot skip a sunk ship.', 'error');
        return;
      }
      plannedMoves[activeViewer].set(selectedMoveShipUid, {
        shipUid: selectedMoveShipUid,
        to: ship.anchor,
        orientation: ship.orientation,
        skip: true,
      });
      if (soundEnabled) {
        void primeAudio();
        sfx.play('move', 0.6);
      }
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
    const phase = game?.phase;
    if (phase === 'firing_p1' || phase === 'firing_p2') {
      targetingOrientation = targetingOrientation === 'H' ? 'V' : 'H';
      render();
      return;
    }
    if (phase === 'movement_p1' || phase === 'movement_p2') {
      movementOrientation = movementOrientation === 'H' ? 'V' : 'H';
      render();
      return;
    }
    placementOrientation = placementOrientation === 'H' ? 'V' : 'H';
    render();
  };

  (document.querySelector('#soundBtn') as HTMLButtonElement).onclick = async () => {
    soundEnabled = !soundEnabled;
    if (soundEnabled) {
      await primeAudio();
      sfx.play('move', 0.8);
    } else {
      sfx.disable();
      audioPrimed = false;
    }
    render();
  };

  (document.querySelector('#soundVol') as HTMLInputElement).oninput = (ev) => {
    soundVolume = Number((ev.target as HTMLInputElement).value);
    sfx.setVolume(soundVolume);
  };
  (document.querySelector('#menuBtn') as HTMLButtonElement).onclick = () => startMenu();

  renderSceneOnly();
  maybeRunAI().catch(console.error);
}

async function doHumanFire(playerId: PlayerId, shipUid: string, target: Coord): Promise<void> {
  if (!game) {
    return;
  }
  if (!canShipFire(game, playerId, shipUid)) {
    setNotice('That ship already fired this round.', 'error');
    return;
  }
  const ship = game.players[playerId].ships.find((s) => s.uid === shipUid);
  if (!ship) {
    setNotice('Invalid ship.', 'error');
    return;
  }

  const salvoOrientation: Orientation = game.mode === '1p' && playerId !== activeViewer ? (rng.int(2) === 0 ? 'H' : 'V') : targetingOrientation;
  const results = resolveSalvo(game, playerId, shipUid, target, salvoOrientation);
  if (!results) {
    setNotice('Invalid shot.', 'error');
    return;
  }

  const gunCount = SHIP_BY_ID[ship.typeId].gunCount;
  const defenderId: PlayerId = playerId === 0 ? 1 : 0;
  const targetBoard = defenderId === activeViewer ? 'own' : 'target';
  const incomingFromSky = defenderId === activeViewer && playerId !== activeViewer;
  const attacker = game.players[playerId];

  const applyMarkerOnce = (pid: PlayerId, marker: { board: 'own' | 'target'; shipUid: string; target: Coord }) => {
    const arr = game!.players[pid].ephemeralImpactMarkers;
    if (!arr.some((m) => m.board === marker.board && m.shipUid === marker.shipUid && m.target.x === marker.target.x && m.target.y === marker.target.y)) {
      arr.push(marker);
    }
  };

  const targets = computeSalvoTargets(target, salvoOrientation, gunCount);
  const hitFlags = targets.map((t) => results.find((r) => r.target.x === t.x && r.target.y === t.y)?.hit ?? false);

  scene.animateSalvo(
    incomingFromSky ? undefined : ship,
    targets,
    hitFlags,
    (i) => {
      // per-shell impact
      const r = results[i];
      if (!r || !game) {
        return;
      }
      const t = r.target;
      if (r.hit && r.hitShipUid) {
        if (soundEnabled) {
          sfx.play('explosion', 1);
        }
        attacker.ephemeralHits.add(`${t.x},${t.y}`);
        applyMarkerOnce(playerId, { board: 'target', shipUid: r.hitShipUid, target: { ...t } });
        applyMarkerOnce(defenderId, { board: 'own', shipUid: r.hitShipUid, target: { ...t } });
      } else {
        if (soundEnabled) {
          sfx.play('splash', 0.9);
        }
        attacker.misses.add(`${t.x},${t.y}`);
      }
      if (r.sunkShipUid) {
        if (soundEnabled) {
          sfx.play('sink', 1);
        }
        scene.sinkShip(r.sunkShipUid);
      }
      renderSceneOnly();
    },
    { targetBoard, incomingFromSky, salvoDelayMs: 80 }
  );

  // cannon sounds on fire
  if (soundEnabled) {
    void primeAudio();
    for (let i = 0; i < targets.length; i += 1) {
      window.setTimeout(() => sfx.play('cannon', 1), i * 80);
    }
  }

  const hitCount = results.filter((r) => r.hit).length;
  setNotice(hitCount ? `Salvo: ${hitCount}/${results.length} hits.` : 'Salvo missed.', hitCount ? 'ok' : '');
  await wait(650);

  const winner = hasWinner(game);
  if (winner !== undefined) {
    game.phase = 'game_over';
    game.winner = winner;
    render();
    return;
  }

  const nextShooter = nextFiringPlayer(game, playerId);
  if (nextShooter === null || (!hasUnfiredShips(game, 0) && !hasUnfiredShips(game, 1))) {
    game.phase = 'movement_p1';
    selectedMoveShipUid = game.players[0].ships.find((s) => !s.sunk && s.placed)?.uid ?? null;
    plannedMoves[0].clear();
    plannedMoves[1].clear();
    selectedFiringShipUid = null;
    if (game.mode === '2p') {
      requestPass(0, 'Firing round complete', () => render());
    } else {
      render();
    }
    return;
  }

  game.phase = nextShooter === 0 ? 'firing_p1' : 'firing_p2';
  selectedFiringShipUid = pickDefaultFiringShip(nextShooter);
  if (game.mode === '2p' && nextShooter !== playerId) {
    requestPass(nextShooter, `${game.players[playerId].name} fired`, () => render());
  } else {
    render();
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
    selectedMoveShipUid = game.players[1].ships.find((s) => !s.sunk && s.placed)?.uid ?? null;
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
  // Clear targeting misses at the start of each new round (per latest rule tweak)
  game.players[0].misses.clear();
  game.players[1].misses.clear();
  game.round += 1;
  resetFiringRound(game);
  game.phase = 'firing_p1';
  selectedFiringShipUid = pickDefaultFiringShip(0);
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
    if (shot) {
      await doHumanFire(1, shot.shipUid, shot.target);
    }
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

async function startOnline(): Promise<void> {
  screen = 'online';
  game = null;
  activeViewer = 0;
  topbar.innerHTML = '';
  phasePrompt.textContent = '';
  phasePrompt.style.display = 'none';
  clearNotice();

  if (!SERVER_URL) {
    leftPanel.innerHTML = `
      <div class="section">
        <h1>Online Multiplayer</h1>
        <p class="notice error">Missing VITE_SERVER_URL. Set it in Vercel env vars.</p>
        <button id="backBtn">Back</button>
      </div>
    `;
    rightPanel.innerHTML = '';
    (document.querySelector('#backBtn') as HTMLButtonElement).onclick = () => startMenu();
    return;
  }

  const serverUrl = SERVER_URL;

  const { getOrCreateDisplayName, getOrCreateSessionId, setDisplayName } = await import('./online/state');
  const { formatRoomRow, rosterText } = await import('./online/ui');

  if (!online) {
    online = {
      sessionId: getOrCreateSessionId(),
      name: getOrCreateDisplayName(),
      connected: false,
      rooms: [],
      room: null,
      role: 'player',
      seat: null,
      notice: '',
    };
  }

  if (!onlineClient) {
    onlineClient = new OnlineClient({ serverUrl });

    onlineClient.socket.on('connect', () => {
      if (!online) return;
      online.connected = true;
      onlineClient!.hello(online.sessionId, online.name);
      renderOnline();
    });
    onlineClient.socket.on('disconnect', () => {
      if (!online) return;
      online.connected = false;
      renderOnline();
    });
    onlineClient.socket.on('error_msg', (p) => {
      if (!online) return;
      online.notice = p.message;
      renderOnline();
    });
    onlineClient.socket.on('info_msg', (p) => {
      if (!online) return;
      online.notice = p.message;
      renderOnline();
    });
    onlineClient.socket.on('room_created', (p) => {
      if (!online) return;
      onlineClient!.joinRoom(p.code, 'player');
    });
    onlineClient.socket.on('join_ok', (p) => {
      if (!online) return;
      online.role = p.role;
      online.seat = p.seat;
      online.notice = `Joined room ${p.code} as ${p.role} (${p.seat}).`;
      renderOnline();
    });
    onlineClient.socket.on('room_state', (p) => {
      if (!online) return;
      online.room = p.room;
      renderOnline();
    });
  }

  async function refreshRooms(): Promise<void> {
    if (!onlineClient || !online) return;
    try {
      online.rooms = await onlineClient.listRooms(serverUrl);
    } catch (e) {
      online.notice = String(e);
    }
  }

  function renderOnline(): void {
    if (!online) return;

    leftPanel.innerHTML = `
      <div class="section">
        <h1>Online Multiplayer</h1>
        <p class="stat">Server: ${serverUrl}</p>
        <p class="stat">Status: ${online.connected ? 'connected' : 'connecting…'}</p>
        <div class="row" style="margin-top:8px; align-items:center;">
          <label class="stat">Name</label>
          <input id="nameInput" value="${online.name.replace(/"/g, '&quot;')}" style="flex:1; min-width: 160px;" />
        </div>
        <div class="row" style="margin-top:8px;">
          <button id="createRoomBtn">Create Room</button>
          <input id="joinCode" placeholder="Room code" style="width: 120px;" />
          <button id="joinRoomBtn">Join</button>
        </div>
        <div class="row" style="margin-top:8px;">
          <button id="refreshRoomsBtn">Refresh Rooms</button>
          <button id="backToMenu">Back</button>
        </div>
        <p class="notice ${online.notice ? 'error' : ''}">${online.notice || ''}</p>
      </div>

      <div class="section">
        <h2>Public Rooms</h2>
        <div class="menu" style="gap:6px;">
          ${online.rooms
            .map((r) => `<button class="roomBtn" data-code="${r.code}">${formatRoomRow(r)}</button>`)
            .join('') || '<p class="stat">No rooms yet.</p>'}
        </div>
      </div>
    `;

    if (!online.room) {
      rightPanel.innerHTML = `
        <div class="section">
          <h2>Lobby</h2>
          <p class="stat">Create or join a room to chat. Gameplay sync comes next.</p>
        </div>
      `;
    } else {
      rightPanel.innerHTML = `
        <div class="section">
          <h2>Room ${online.room.code}</h2>
          <p class="stat">${online.room.title}</p>
          <pre class="stat" style="white-space: pre-wrap;">${rosterText(online.room)}</pre>
          <div class="row" style="margin-top:8px;">
            <button id="leaveRoomBtn">Leave Room</button>
          </div>
        </div>

        <div class="section">
          <h2>Chat</h2>
          <div class="chatLog" id="chatLog">
            ${online.room.chat
              .map((m) => `<div class="chatMsg"><span class="chatName">${m.name}</span><span class="chatText">${m.text}</span></div>`)
              .join('')}
          </div>
          <div class="row" style="margin-top:8px;">
            <input id="chatInput" placeholder="Message…" style="flex:1;" />
            <button id="chatSendBtn">Send</button>
          </div>
        </div>
      `;
    }

    scene.renderState({
      ownShips: [],
      targetMisses: new Set(),
      targetEphemeralHits: new Set(),
      ephemeralImpactMarkers: [],
      previewCells: [],
      previewColor: 0x66c9f0,
    });

    (document.querySelector('#backToMenu') as HTMLButtonElement).onclick = () => startMenu();

    const nameEl = document.querySelector('#nameInput') as HTMLInputElement;
    nameEl.onchange = () => {
      if (!online) return;
      online.name = nameEl.value.trim() || online.name;
      setDisplayName(online.name);
      onlineClient?.hello(online.sessionId, online.name);
      renderOnline();
    };

    (document.querySelector('#createRoomBtn') as HTMLButtonElement).onclick = () => {
      if (!onlineClient || !online) return;
      onlineClient.createRoom(`${online.name}'s room`);
    };

    (document.querySelector('#joinRoomBtn') as HTMLButtonElement).onclick = () => {
      if (!onlineClient) return;
      const code = (document.querySelector('#joinCode') as HTMLInputElement).value.trim();
      if (!code) return;
      onlineClient.joinRoom(code, 'player');
    };

    (document.querySelector('#refreshRoomsBtn') as HTMLButtonElement).onclick = async () => {
      await refreshRooms();
      renderOnline();
    };

    document.querySelectorAll('button.roomBtn').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        const code = (b as HTMLButtonElement).dataset.code!;
        onlineClient?.joinRoom(code, 'player');
      };
    });

    const leaveBtn = document.querySelector('#leaveRoomBtn') as HTMLButtonElement | null;
    if (leaveBtn) {
      leaveBtn.onclick = () => {
        onlineClient?.leaveRoom();
        if (online) {
          online.room = null;
          online.seat = null;
          online.role = 'player';
        }
        renderOnline();
      };
    }

    const sendBtn = document.querySelector('#chatSendBtn') as HTMLButtonElement | null;
    const input = document.querySelector('#chatInput') as HTMLInputElement | null;
    if (sendBtn && input && online.room) {
      const send = () => {
        const text = input.value.trim();
        if (!text) return;
        onlineClient?.chatSend(online!.room!.code, text);
        input.value = '';
      };
      sendBtn.onclick = send;
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') {
          send();
        }
      };
      const log = document.querySelector('#chatLog') as HTMLDivElement | null;
      if (log) {
        log.scrollTop = log.scrollHeight;
      }
    }
  }

  await refreshRooms();
  renderOnline();
}

startMenu();
