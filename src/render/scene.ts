import * as THREE from 'three';
import { BOARD_SIZE, SHIP_BY_ID, SHIP_COLORS } from '../engine/data';
import { shipCells } from '../engine/rules';
import type { Coord, EphemeralImpactMarker, ShipInstance } from '../engine/types';

type BoardKind = 'own' | 'target';

interface MeshShip {
  group: THREE.Group;
  hullMaterials: THREE.MeshStandardMaterial[];
  hitMarkers: THREE.Group;
  baseY: number;
  targetPos: THREE.Vector3;
  targetRotY: number;
  sunkAnim?: { t: number; startY: number };
}

interface ProjectileAnim {
  mesh: THREE.Mesh;
  start: THREE.Vector3;
  control: THREE.Vector3;
  end: THREE.Vector3;
  t: number;
  duration: number;
  onDone: (() => void) | undefined;
}

interface FlashAnim {
  mesh: THREE.Mesh;
  t: number;
  duration: number;
}

interface ImpactAnim {
  mesh: THREE.Mesh;
  t: number;
  duration: number;
}

interface SmokePuff {
  mesh: THREE.Mesh;
  phase: number;
  driftX: number;
  driftZ: number;
}

interface ImpactSmokeMarker {
  group: THREE.Group;
  puffs: SmokePuff[];
  startedAtMs: number;
}

interface ShotAnimOptions {
  targetBoard?: BoardKind;
  incomingFromSky?: boolean;
  salvoDelayMs?: number;
}

export interface SceneState {
  ownShips: ShipInstance[];
  targetMisses: Set<string>;
  targetEphemeralHits: Set<string>;
  ephemeralImpactMarkers: EphemeralImpactMarker[];
  firingReadyShipUids?: Set<string>;
  firingSpentShipUids?: Set<string>;
  previewCells: Coord[];
  previewBoard?: BoardKind;
  previewColor: number;
  selectedOwnCell?: Coord;
  selectedTargetCell?: Coord;
  pulseShipUid?: string | null;
}

export class BattleScene {
  private renderer: THREE.WebGLRenderer;
  private pulseShipUid: string | null = null;
  private pulsePhase = 0;
  private radarGroup = new THREE.Group();
  private radarSweep: THREE.Mesh | null = null;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private ownBoard = new THREE.Group();
  private targetBoard = new THREE.Group();
  private ownOffset = new THREE.Vector3(-7.5, 0, 0);
  private targetOffset = new THREE.Vector3(7.5, 0, 0);
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private boardTiles: THREE.Mesh[] = [];
  private markerGroup = new THREE.Group();
  private previewGroup = new THREE.Group();
  private selectionGroup = new THREE.Group();
  private shipLayer = new THREE.Group();
  private impactSmokeLayer = new THREE.Group();
  private ships = new Map<string, MeshShip>();
  private impactSmokes = new Map<string, ImpactSmokeMarker>();
  private projectileAnims: ProjectileAnim[] = [];
  private flashAnims: FlashAnim[] = [];
  private impactAnims: ImpactAnim[] = [];
  private shotTimers: number[] = [];
  private lastTime = performance.now();

  constructor(private host: HTMLElement) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x3b6f93);

    this.camera = new THREE.PerspectiveCamera(52, host.clientWidth / host.clientHeight, 0.1, 1000);
    this.camera.position.set(0, 14, 20);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(host.clientWidth, host.clientHeight);
    this.host.appendChild(this.renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xd7ecff, 0x4d738f, 1.65);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(12, 20, 6);
    this.scene.add(dir);
    const rim = new THREE.DirectionalLight(0xc7ebff, 0.8);
    rim.position.set(-10, 12, -14);
    this.scene.add(rim);

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(50, 40),
      new THREE.MeshStandardMaterial({ color: 0x2f678d, roughness: 0.42, metalness: 0.2, emissive: 0x12334d, emissiveIntensity: 0.35 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.4;
    this.scene.add(water);

    this.scene.add(this.ownBoard);
    this.scene.add(this.targetBoard);
    this.scene.add(this.shipLayer);
    this.scene.add(this.impactSmokeLayer);
    this.scene.add(this.markerGroup);
    this.scene.add(this.previewGroup);
    this.scene.add(this.selectionGroup);

    this.buildBoard(this.ownBoard, 'own', this.ownOffset);
    this.buildBoard(this.targetBoard, 'target', this.targetOffset);
    this.buildRadarOverlay();

    window.addEventListener('resize', this.onResize);
    this.tick();
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    for (const id of this.shotTimers) {
      window.clearTimeout(id);
    }
    this.shotTimers = [];
    this.renderer.dispose();
  }

  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  pick(clientX: number, clientY: number): { board: BoardKind; cell: Coord } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.boardTiles);
    const first = hits[0]?.object as THREE.Mesh | undefined;
    if (!first) {
      return null;
    }
    const board = first.userData.board as BoardKind;
    return { board, cell: { x: first.userData.x as number, y: first.userData.y as number } };
  }

  worldForCell(board: BoardKind, cell: Coord): THREE.Vector3 {
    const base = board === 'own' ? this.ownOffset : this.targetOffset;
    return new THREE.Vector3(base.x - 4.5 + cell.x, 0.15, base.z - 4.5 + cell.y);
  }

  animateSalvo(
    fromOwnShip: ShipInstance | undefined,
    targets: Coord[],
    hitFlags: boolean[],
    onImpactEach?: (index: number) => void,
    options: ShotAnimOptions = {}
  ): void {
    const targetBoard = options.targetBoard ?? 'target';
    const incomingFromSky = options.incomingFromSky ?? false;
    const salvoDelayMs = options.salvoDelayMs ?? 80;

    const muzzlePoints = this.computeSegmentMuzzles(fromOwnShip, targets.length, incomingFromSky, targetBoard, targets);

    for (let i = 0; i < targets.length; i += 1) {
      const muzzle = muzzlePoints[i]!;
      const target = targets[i]!;
      const hit = hitFlags[i] ?? false;
      const end = this.worldForCell(targetBoard, target);
      end.y = 0.28;

      const timerId = window.setTimeout(() => {
        this.shotTimers = this.shotTimers.filter((id) => id !== timerId);

        if (!incomingFromSky) {
          const flash = new THREE.Mesh(
            new THREE.SphereGeometry(0.22, 10, 10),
            new THREE.MeshBasicMaterial({ color: 0xffdca5, transparent: true, opacity: 0.9 })
          );
          flash.position.copy(muzzle);
          this.scene.add(flash);
          this.flashAnims.push({ mesh: flash, t: 0, duration: 0.18 });
        }

        const control = muzzle.clone().lerp(end, 0.5);
        control.y += incomingFromSky ? 1.4 : 3.8;
        const proj = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffc36a }));
        proj.position.copy(muzzle);
        this.scene.add(proj);
        this.projectileAnims.push({
          mesh: proj,
          start: muzzle.clone(),
          control,
          end: end.clone(),
          t: 0,
          duration: incomingFromSky ? 0.42 + i * 0.02 : 0.55 + i * 0.025,
          onDone: () => this.spawnImpact(end, hit, () => onImpactEach?.(i)),
        });
      }, i * salvoDelayMs);

      this.shotTimers.push(timerId);
    }
  }

  // Back-compat helper: single-target shot.
  animateShot(
    fromOwnShip: ShipInstance | undefined,
    target: Coord,
    gunCount: number,
    hit: boolean,
    onImpact?: () => void,
    options: ShotAnimOptions = {}
  ): void {
    this.animateSalvo(fromOwnShip, [target], [hit], () => onImpact?.(), options);
  }

  sinkShip(uid: string): void {
    const ms = this.ships.get(uid);
    if (ms) {
      ms.sunkAnim = { t: 0, startY: ms.group.position.y };
    }
  }

  renderState(state: SceneState): void {
    this.pulseShipUid = state.pulseShipUid ?? null;
    this.rebuildShips(state.ownShips, state.firingReadyShipUids, state.firingSpentShipUids);
    this.rebuildImpactSmokes(state.ephemeralImpactMarkers, state.ownShips);
    this.rebuildMarkers(state.targetMisses, state.targetEphemeralHits);
    this.rebuildPreview(state.previewCells, state.previewColor, state.selectedOwnCell, state.selectedTargetCell, state.previewBoard ?? 'own');
  }

  private onResize = (): void => {
    this.camera.aspect = this.host.clientWidth / this.host.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.host.clientWidth, this.host.clientHeight);
  };

  private buildBoard(group: THREE.Group, board: BoardKind, offset: THREE.Vector3): void {
    const isRadar = board === 'target';
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(11.2, 0.22, 11.2),
      new THREE.MeshStandardMaterial({
        color: isRadar ? 0x1a6b49 : 0x7fb4d8,
        roughness: 0.4,
        metalness: 0.35,
        emissive: isRadar ? 0x0c2519 : 0x264d66,
        emissiveIntensity: isRadar ? 0.42 : 0.25,
      })
    );
    frame.position.copy(offset.clone().setY(-0.02));
    group.add(frame);

    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const shade =
          board === 'target'
            ? (x + y) % 2 === 0
              ? 0x154c33
              : 0x0f3f2a
            : (x + y) % 2 === 0
              ? 0x8ec4e8
              : 0x79afd5;
        const tile = new THREE.Mesh(
          new THREE.BoxGeometry(0.95, 0.06, 0.95),
          new THREE.MeshStandardMaterial({
            color: shade,
            roughness: 0.35,
            metalness: 0.2,
            emissive: board === 'target' ? 0x071c12 : 0x1d4d69,
            emissiveIntensity: board === 'target' ? 0.32 : 0.16,
          })
        );
        tile.position.set(offset.x - 4.5 + x, 0.02, offset.z - 4.5 + y);
        tile.userData.board = board;
        tile.userData.x = x;
        tile.userData.y = y;
        group.add(tile);
        this.boardTiles.push(tile);
      }
    }

    const points: THREE.Vector3[] = [];
    const gridY = 0.1;
    const startX = offset.x - 5;
    const startZ = offset.z - 5;
    for (let i = 0; i <= BOARD_SIZE; i += 1) {
      const x = startX + i;
      const z = startZ + i;
      points.push(new THREE.Vector3(x, gridY, startZ), new THREE.Vector3(x, gridY, startZ + BOARD_SIZE));
      points.push(new THREE.Vector3(startX, gridY, z), new THREE.Vector3(startX + BOARD_SIZE, gridY, z));
    }
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({
        color: board === 'target' ? 0x4ec48c : 0xe9f7ff,
        transparent: true,
        opacity: board === 'target' ? 0.55 : 0.95,
      })
    );
    group.add(grid);
  }

  private buildRadarOverlay(): void {
    // A subtle radar sweep + radial spokes on the targeting board.
    this.radarGroup.clear();
    const center = new THREE.Vector3(this.targetOffset.x, 0.12, this.targetOffset.z);
    this.radarGroup.position.copy(center);

    const radius = 5.05;

    // radial spokes
    const spokes: THREE.Vector3[] = [];
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2;
      spokes.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    }
    const spokesMesh = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(spokes),
      new THREE.LineBasicMaterial({ color: 0x4ec48c, transparent: true, opacity: 0.18 })
    );
    this.radarGroup.add(spokesMesh);

    // sweep line (thin triangle/plane rotated around Y)
    const sweepGeom = new THREE.PlaneGeometry(radius, 0.06);
    const sweepMat = new THREE.MeshBasicMaterial({
      color: 0x7bffbf,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const sweep = new THREE.Mesh(sweepGeom, sweepMat);
    sweep.rotation.x = -Math.PI / 2;
    sweep.position.set(radius / 2, 0.002, 0);
    this.radarGroup.add(sweep);
    this.radarSweep = sweep;

    // faint ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius - 0.02, radius, 64),
      new THREE.MeshBasicMaterial({ color: 0x4ec48c, transparent: true, opacity: 0.12, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    this.radarGroup.add(ring);

    this.scene.add(this.radarGroup);
  }

  private rebuildShips(
    ships: ShipInstance[],
    readyShipUids: Set<string> | undefined,
    spentShipUids: Set<string> | undefined
  ): void {
    const keep = new Set<string>();
    for (const ship of ships) {
      if (!ship.placed) {
        continue;
      }
      keep.add(ship.uid);
      let ms = this.ships.get(ship.uid);
      if (!ms) {
        const g = new THREE.Group();
        const hull = this.buildShipHull(shipCells(ship).length * 0.9, ship.typeId);
        g.add(hull.group);
        const hitMarkers = new THREE.Group();
        hitMarkers.position.set(0, 0.24, 0);
        g.add(hitMarkers);
        this.shipLayer.add(g);
        ms = {
          group: g,
          hullMaterials: hull.materials,
          hitMarkers,
          baseY: 0.24,
          targetPos: g.position.clone(),
          targetRotY: g.rotation.y,
        };
        this.ships.set(ship.uid, ms);
      }

      const size = SHIP_BY_ID[ship.typeId].size;
      const damageN = size ? Math.min(1, ship.hits.size / size) : 0;
      const baseColor = new THREE.Color(SHIP_COLORS[ship.typeId]);
      const damagedColor = baseColor.clone().lerp(new THREE.Color(0x6d4f49), damageN * 0.55);
      for (const mat of ms.hullMaterials) {
        mat.color.copy(damagedColor);
        mat.emissive.setHex(SHIP_COLORS[ship.typeId]);
        mat.emissive.lerp(new THREE.Color(0x241615), damageN * 0.7);
        mat.opacity = 0.96;
        mat.emissiveIntensity = 0.16 + (readyShipUids?.has(ship.uid) ? 0.13 : 0);
        if (spentShipUids?.has(ship.uid)) {
          mat.color.lerp(new THREE.Color(0x68737e), 0.4);
          mat.emissiveIntensity = 0.05;
          mat.opacity = 0.78;
        }
      }

      // Persistent own-ship hit markers (so damage is obvious during movement).
      ms.hitMarkers.clear();
      for (const idx of ship.hits) {
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.12, 10, 10),
          new THREE.MeshBasicMaterial({ color: 0xff5b4a })
        );
        if (ship.orientation === 'H') {
          dot.position.set(idx - (SHIP_BY_ID[ship.typeId].size - 1) * 0.45, 0.02, 0);
        } else {
          dot.position.set(0, 0.02, idx - (SHIP_BY_ID[ship.typeId].size - 1) * 0.45);
        }
        ms.hitMarkers.add(dot);
      }

      const pos = this.worldForCell('own', ship.anchor);
      const desiredX = pos.x + (ship.orientation === 'H' ? (shipCells(ship).length - 1) * 0.45 : 0);
      const desiredZ = pos.z + (ship.orientation === 'V' ? (shipCells(ship).length - 1) * 0.45 : 0);
      const desiredRotY = ship.orientation === 'H' ? 0 : Math.PI / 2;

      ms.targetPos.set(desiredX, ms.baseY, desiredZ);
      ms.targetRotY = desiredRotY;

      // Snap new ships into place; existing ships will smoothly interpolate in tick().
      if (ms.group.position.lengthSq() < 0.0001) {
        ms.group.position.copy(ms.targetPos);
        ms.group.rotation.y = ms.targetRotY;
      }
    }

    for (const [uid, ms] of this.ships) {
      if (!keep.has(uid)) {
        this.shipLayer.remove(ms.group);
        this.ships.delete(uid);
      }
    }
  }

  private buildShipHull(length: number, typeId: ShipInstance['typeId']): { group: THREE.Group; materials: THREE.MeshStandardMaterial[] } {
    const hullGroup = new THREE.Group();
    const base = SHIP_COLORS[typeId];
    const hullMat = new THREE.MeshStandardMaterial({
      color: base,
      roughness: 0.36,
      metalness: 0.58,
      emissive: base,
      emissiveIntensity: 0.16,
      transparent: true,
      opacity: 0.96,
    });
    const towerMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(base).lerp(new THREE.Color(0xb4c0c9), 0.22),
      roughness: 0.34,
      metalness: 0.62,
      emissive: base,
      emissiveIntensity: 0.12,
      transparent: true,
      opacity: 0.96,
    });

    const sternLen = Math.max(0.2, length * 0.22);
    const midLen = Math.max(0.22, length * 0.42);
    const bowLen = Math.max(0.2, length - sternLen - midLen);
    const sternX = -length * 0.5 + sternLen * 0.5;
    const midX = -length * 0.5 + sternLen + midLen * 0.5;
    const bowBaseX = -length * 0.5 + sternLen + midLen;

    const stern = new THREE.Mesh(new THREE.BoxGeometry(sternLen, 0.28, 0.7), hullMat);
    stern.position.set(sternX, 0, 0);
    hullGroup.add(stern);

    const mid = new THREE.Mesh(new THREE.BoxGeometry(midLen, 0.34, 0.82), hullMat);
    mid.position.set(midX, 0.02, 0);
    hullGroup.add(mid);

    const bowA = new THREE.Mesh(new THREE.BoxGeometry(bowLen * 0.5, 0.3, 0.66), hullMat);
    bowA.position.set(bowBaseX + bowLen * 0.25, 0.01, 0);
    hullGroup.add(bowA);
    const bowB = new THREE.Mesh(new THREE.BoxGeometry(bowLen * 0.3, 0.26, 0.5), hullMat);
    bowB.position.set(bowBaseX + bowLen * 0.65, 0.02, 0);
    hullGroup.add(bowB);
    const bowC = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.1, bowLen * 0.2), 0.2, 0.34), hullMat);
    bowC.position.set(bowBaseX + bowLen * 0.9, 0.03, 0);
    hullGroup.add(bowC);

    const superLen = Math.max(0.22, Math.min(0.55, length * 0.26));
    const superStruct = new THREE.Mesh(new THREE.BoxGeometry(superLen, 0.18, 0.34), towerMat);
    superStruct.position.set(-length * 0.12, 0.28, 0);
    hullGroup.add(superStruct);

    return { group: hullGroup, materials: [hullMat, towerMat] };
  }

  private rebuildMarkers(misses: Set<string>, hits: Set<string>): void {
    this.markerGroup.clear();

    for (const k of misses) {
      const parts = k.split(',');
      const x = Number(parts[0] ?? 0);
      const y = Number(parts[1] ?? 0);
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.12, 0.25, 16),
        new THREE.MeshBasicMaterial({ color: 0xe8f7ff, side: THREE.DoubleSide })
      );
      m.rotation.x = -Math.PI / 2;
      const p = this.worldForCell('target', { x, y });
      m.position.set(p.x, 0.16, p.z);
      this.markerGroup.add(m);
    }

    for (const k of hits) {
      const parts = k.split(',');
      const x = Number(parts[0] ?? 0);
      const y = Number(parts[1] ?? 0);
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0xff5b4a })
      );
      const p = this.worldForCell('target', { x, y });
      m.position.set(p.x, 0.25, p.z);
      this.markerGroup.add(m);
    }
  }

  private rebuildPreview(cells: Coord[], color: number, own?: Coord, target?: Coord, previewBoard: BoardKind = 'own'): void {
    this.previewGroup.clear();
    this.selectionGroup.clear();

    for (const c of cells) {
      const p = this.worldForCell(previewBoard, c);
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(0.92, 0.07, 0.92),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 })
      );
      tile.position.set(p.x, 0.22, p.z);
      this.previewGroup.add(tile);
    }

    // Selection rings removed (preview highlights are sufficient).

  }

  private spawnImpact(pos: THREE.Vector3, hit: boolean, cb?: () => void): void {
    const imp = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 10, 10),
      new THREE.MeshBasicMaterial({ color: hit ? 0xff7b5c : 0x9cb7c8, transparent: true, opacity: 0.8 })
    );
    imp.position.copy(pos);
    this.scene.add(imp);
    this.impactAnims.push({ mesh: imp, t: 0, duration: 0.45 });
    cb?.();
  }

  private rebuildImpactSmokes(markers: EphemeralImpactMarker[], ownShips: ShipInstance[]): void {
    const keep = new Set<string>();
    for (const marker of markers) {
      const markerKey = `${marker.board}:${marker.shipUid}:${marker.target.x},${marker.target.y}`;
      keep.add(markerKey);

      let smoke = this.impactSmokes.get(markerKey);
      if (!smoke) {
        smoke = this.createImpactSmoke();
        this.impactSmokes.set(markerKey, smoke);
      }
      this.positionImpactSmoke(smoke.group, marker, ownShips);
    }

    for (const [smokeKey, smoke] of this.impactSmokes) {
      if (!keep.has(smokeKey)) {
        smoke.group.parent?.remove(smoke.group);
        this.impactSmokes.delete(smokeKey);
      }
    }
  }

  private createImpactSmoke(): ImpactSmokeMarker {
    const group = new THREE.Group();
    const puffs: SmokePuff[] = [];

    // Hit dot for own-ship impacts (matches the target-board red hit marker vibe)
    const hitDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xff5b4a, transparent: true, opacity: 0.95 })
    );
    hitDot.name = 'hitDot';
    hitDot.position.set(0, 0.05, 0);
    hitDot.visible = false;
    group.add(hitDot);

    for (let i = 0; i < 2; i += 1) {
      const scorch = new THREE.Mesh(
        new THREE.RingGeometry(0.01, 0.13 + i * 0.03, 16),
        new THREE.MeshBasicMaterial({
          color: 0x111111,
          transparent: true,
          opacity: 0.5 - i * 0.12,
          depthWrite: false,
        })
      );
      scorch.rotation.x = -Math.PI / 2;
      scorch.position.set((i === 0 ? -1 : 1) * 0.06, 0, i === 0 ? 0.04 : -0.03);
      group.add(scorch);
    }

    for (let i = 0; i < 3; i += 1) {
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 8, 8),
        new THREE.MeshBasicMaterial({
          color: 0x1a1a1a,
          transparent: true,
          opacity: 0.24,
          depthWrite: false,
        })
      );
      puff.position.set(0, 0.08 + i * 0.04, 0);
      group.add(puff);
      puffs.push({
        mesh: puff,
        phase: i * 0.33,
        driftX: (i - 1) * 0.05,
        driftZ: (i % 2 === 0 ? 1 : -1) * 0.04,
      });
    }

    return { group, puffs, startedAtMs: performance.now() };
  }

  private positionImpactSmoke(group: THREE.Group, marker: EphemeralImpactMarker, ownShips: ShipInstance[]): void {
    const hitDot = group.getObjectByName('hitDot') as THREE.Mesh | null;
    if (hitDot) {
      hitDot.visible = marker.board === 'own';
    }

    if (marker.board === 'target') {
      if (group.parent !== this.impactSmokeLayer) {
        group.parent?.remove(group);
        this.impactSmokeLayer.add(group);
      }
      const p = this.worldForCell('target', marker.target);
      group.position.set(p.x, 0.28, p.z);
      group.rotation.y = 0;
      return;
    }

    const ship = ownShips.find((s) => s.uid === marker.shipUid && s.placed);
    const meshShip = this.ships.get(marker.shipUid);
    const local = ship ? this.impactOffsetForShipCell(ship, marker.target) : null;
    if (!meshShip || !local) {
      group.parent?.remove(group);
      return;
    }

    if (group.parent !== meshShip.group) {
      group.parent?.remove(group);
      meshShip.group.add(group);
    }
    group.position.copy(local);
    group.rotation.y = 0;
  }

  private impactOffsetForShipCell(ship: ShipInstance, target: Coord): THREE.Vector3 | null {
    const size = shipCells(ship).length;
    if (ship.orientation === 'H') {
      if (target.y !== ship.anchor.y) {
        return null;
      }
      const i = target.x - ship.anchor.x;
      if (i < 0 || i >= size) {
        return null;
      }
      return new THREE.Vector3(i - (size - 1) * 0.45, 0.22, 0);
    }
    if (target.x !== ship.anchor.x) {
      return null;
    }
    const i = target.y - ship.anchor.y;
    if (i < 0 || i >= size) {
      return null;
    }
    return new THREE.Vector3(0, 0.22, i - (size - 1) * 0.45);
  }

  private tick = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    this.projectileAnims = this.projectileAnims.filter((anim) => {
      anim.t += dt;
      const n = Math.min(anim.t / anim.duration, 1);
      const p = this.quadraticBezier(anim.start, anim.control, anim.end, n);
      anim.mesh.position.copy(p);
      if (n >= 1) {
        this.scene.remove(anim.mesh);
        anim.onDone?.();
        return false;
      }
      return true;
    });

    this.flashAnims = this.flashAnims.filter((anim) => {
      anim.t += dt;
      const n = anim.t / anim.duration;
      const s = 1 + n * 1.8;
      anim.mesh.scale.setScalar(s);
      const mat = anim.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 0.9 - n * 0.9);
      if (n >= 1) {
        this.scene.remove(anim.mesh);
        return false;
      }
      return true;
    });

    this.impactAnims = this.impactAnims.filter((anim) => {
      anim.t += dt;
      const n = anim.t / anim.duration;
      const s = 1 + n * 2;
      anim.mesh.scale.setScalar(s);
      const mat = anim.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 0.8 - n * 0.8);
      if (n >= 1) {
        this.scene.remove(anim.mesh);
        return false;
      }
      return true;
    });

    for (const smoke of this.impactSmokes.values()) {
      const age = (now - smoke.startedAtMs) / 1000;
      for (const puff of smoke.puffs) {
        const t = (age * 0.35 + puff.phase) % 1;
        const scale = 0.65 + t * 1.35;
        puff.mesh.scale.setScalar(scale);
        puff.mesh.position.x = puff.driftX * t;
        puff.mesh.position.z = puff.driftZ * t;
        puff.mesh.position.y = 0.06 + t * 0.44;
        const mat = puff.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, 0.24 * (1 - t));
      }
    }

    // Smooth ship motion for movement planning previews.
    const lerp = 1 - Math.exp(-dt * 12);
    this.pulsePhase += dt;
    const pulse = 0.5 + 0.5 * Math.sin(this.pulsePhase * (Math.PI * 2) * 1.05);
    for (const [uid, ms] of this.ships) {
      if (ms.sunkAnim) {
        continue;
      }
      ms.group.position.x += (ms.targetPos.x - ms.group.position.x) * lerp;
      ms.group.position.z += (ms.targetPos.z - ms.group.position.z) * lerp;
      ms.group.position.y = ms.baseY;
      ms.group.rotation.y += (ms.targetRotY - ms.group.rotation.y) * lerp;

      // Subtle pulse highlight (movement selection)
      const isPulse = this.pulseShipUid && uid === this.pulseShipUid;
      for (const mat of ms.hullMaterials) {
        const base = isPulse ? 0.28 : 0.16;
        const extra = isPulse ? 0.34 * pulse : 0;
        mat.emissiveIntensity = base + extra;
      }
    }

    if (this.radarSweep) {
      this.radarSweep.rotation.z = this.pulsePhase * 1.1;
    }

    for (const [, ms] of this.ships) {
      if (!ms.sunkAnim) {
        continue;
      }
      ms.sunkAnim.t += dt;
      const n = Math.min(ms.sunkAnim.t / 2.4, 1);
      ms.group.rotation.z = -n * 0.7;
      ms.group.position.y = ms.sunkAnim.startY - n * 1.4;
      for (const mat of ms.hullMaterials) {
        mat.opacity = Math.max(0, 0.96 - n);
      }
      // (HP UI removed)

      if (n >= 1) {
        this.shipLayer.remove(ms.group);
      }
    }

    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.tick);
  };

  private quadraticBezier(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, t: number): THREE.Vector3 {
    const ab = a.clone().lerp(b, t);
    const bc = b.clone().lerp(c, t);
    return ab.lerp(bc, t);
  }

  private computeSegmentMuzzles(
    ship: ShipInstance | undefined,
    gunCount: number,
    incomingFromSky: boolean,
    targetBoard: BoardKind,
    targets: Coord[]
  ): THREE.Vector3[] {
    const total = Math.max(1, gunCount);
    if (incomingFromSky || !ship) {
      // One spawn point per shell, roughly above the target line.
      return targets.map((t, i) => {
        const center = this.worldForCell(targetBoard, t);
        const p = center.clone();
        p.y = 6.2;
        p.x += (i - (targets.length - 1) / 2) * 0.35;
        p.z += (i % 2 === 0 ? 1 : -1) * 0.15;
        return p;
      });
    }

    // Simple mapping: shell i originates from ship segment i.
    const cells = shipCells(ship);
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < total; i += 1) {
      const cell = cells[Math.min(i, cells.length - 1)]!;
      const wp = this.worldForCell('own', cell);
      wp.y = 0.65;
      out.push(wp);
    }
    return out;
  }

  private computeMuzzles(
    ship: ShipInstance | undefined,
    gunCount: number,
    incomingFromSky: boolean,
    targetBoard: BoardKind,
    target: Coord
  ): THREE.Vector3[] {
    const total = Math.max(1, gunCount);
    if (incomingFromSky || !ship) {
      const center = this.worldForCell(targetBoard, target);
      const muzzles: THREE.Vector3[] = [];
      for (let i = 0; i < total; i += 1) {
        const arc = total > 1 ? i / (total - 1) - 0.5 : 0;
        const p = center.clone();
        p.x += arc * 1.2;
        p.z += (i % 2 === 0 ? -1 : 1) * (0.18 + Math.floor(i / 2) * 0.12);
        p.y = 7 + Math.abs(arc) * 1.4;
        muzzles.push(p);
      }
      return muzzles;
    }

    const cells = shipCells(ship);
    const len = cells.length;
    const muzzles: THREE.Vector3[] = [];
    for (let i = 0; i < total; i += 1) {
      const cellIndex = total === 1 ? Math.floor((len - 1) / 2) : Math.round((i * (len - 1)) / (total - 1));
      const p = this.worldForCell('own', cells[cellIndex]!);
      const spread = total > 1 ? i / (total - 1) - 0.5 : 0;
      const lateral = (i % 2 === 0 ? -1 : 1) * (0.08 + Math.floor(i / 2) * 0.08);
      if (ship.orientation === 'H') {
        p.x += spread * 0.25;
        p.z += lateral;
      } else {
        p.x += lateral;
        p.z += spread * 0.25;
      }
      p.y = 0.55;
      muzzles.push(p);
    }
    return muzzles;
  }
}
