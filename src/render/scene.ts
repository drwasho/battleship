import * as THREE from 'three';
import { BOARD_SIZE, SHIP_COLORS } from '../engine/data';
import { shipCells } from '../engine/rules';
import type { Coord, ShipInstance } from '../engine/types';

type BoardKind = 'own' | 'target';

interface MeshShip {
  group: THREE.Group;
  baseY: number;
  sunkAnim?: { t: number; startY: number };
}

interface ProjectileAnim {
  mesh: THREE.Mesh;
  start: THREE.Vector3;
  control: THREE.Vector3;
  end: THREE.Vector3;
  t: number;
  duration: number;
  onDone?: () => void;
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

export interface SceneState {
  ownShips: ShipInstance[];
  ownShipHpPercent: Map<string, number>;
  targetMisses: Set<string>;
  targetEphemeralHits: Set<string>;
  previewCells: Coord[];
  previewColor: number;
  selectedOwnCell?: Coord;
  selectedTargetCell?: Coord;
}

export class BattleScene {
  private renderer: THREE.WebGLRenderer;
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
  private ships = new Map<string, MeshShip>();
  private projectileAnims: ProjectileAnim[] = [];
  private flashAnims: FlashAnim[] = [];
  private impactAnims: ImpactAnim[] = [];
  private lastTime = performance.now();

  constructor(private host: HTMLElement) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07111b);

    this.camera = new THREE.PerspectiveCamera(52, host.clientWidth / host.clientHeight, 0.1, 1000);
    this.camera.position.set(0, 14, 20);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(host.clientWidth, host.clientHeight);
    this.host.appendChild(this.renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xa8ccf2, 0x0f1722, 1.2);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(12, 20, 6);
    this.scene.add(dir);

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(50, 40),
      new THREE.MeshStandardMaterial({ color: 0x0b1f33, roughness: 0.75, metalness: 0.1 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.4;
    this.scene.add(water);

    this.scene.add(this.ownBoard);
    this.scene.add(this.targetBoard);
    this.scene.add(this.shipLayer);
    this.scene.add(this.markerGroup);
    this.scene.add(this.previewGroup);
    this.scene.add(this.selectionGroup);

    this.buildBoard(this.ownBoard, 'own', this.ownOffset);
    this.buildBoard(this.targetBoard, 'target', this.targetOffset);

    window.addEventListener('resize', this.onResize);
    this.tick();
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
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

  animateShot(fromOwnShip: ShipInstance | undefined, target: Coord, gunCount: number, hit: boolean, onImpact?: () => void): void {
    const muzzle = fromOwnShip
      ? this.worldForCell('own', shipCells(fromOwnShip)[Math.floor(shipCells(fromOwnShip).length / 2)]!)
      : new THREE.Vector3(this.ownOffset.x, 0.4, this.ownOffset.z);
    muzzle.y = 0.55;
    const end = this.worldForCell('target', target);
    end.y = 0.28;
    const control = muzzle.clone().lerp(end, 0.5);
    control.y += 3.8;

    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xffdca5, transparent: true, opacity: 0.9 })
    );
    flash.position.copy(muzzle);
    this.scene.add(flash);
    this.flashAnims.push({ mesh: flash, t: 0, duration: 0.18 });

    for (let i = 0; i < gunCount; i += 1) {
      const proj = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffc36a })
      );
      proj.position.copy(muzzle);
      this.scene.add(proj);
      this.projectileAnims.push({
        mesh: proj,
        start: muzzle.clone(),
        control: control.clone().add(new THREE.Vector3((i - gunCount / 2) * 0.15, 0, 0)),
        end: end.clone(),
        t: 0,
        duration: 0.55 + i * 0.03,
        onDone: i === gunCount - 1 ? () => this.spawnImpact(end, hit, onImpact) : undefined,
      });
    }
  }

  sinkShip(uid: string): void {
    const ms = this.ships.get(uid);
    if (ms) {
      ms.sunkAnim = { t: 0, startY: ms.group.position.y };
    }
  }

  renderState(state: SceneState): void {
    this.rebuildShips(state.ownShips, state.ownShipHpPercent);
    this.rebuildMarkers(state.targetMisses, state.targetEphemeralHits);
    this.rebuildPreview(state.previewCells, state.previewColor, state.selectedOwnCell, state.selectedTargetCell);
  }

  private onResize = (): void => {
    this.camera.aspect = this.host.clientWidth / this.host.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.host.clientWidth, this.host.clientHeight);
  };

  private buildBoard(group: THREE.Group, board: BoardKind, offset: THREE.Vector3): void {
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(11.2, 0.22, 11.2),
      new THREE.MeshStandardMaterial({ color: 0x173149, roughness: 0.65, metalness: 0.35 })
    );
    frame.position.copy(offset.clone().setY(-0.02));
    group.add(frame);

    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const shade = (x + y) % 2 === 0 ? 0x24435d : 0x1f3951;
        const tile = new THREE.Mesh(
          new THREE.BoxGeometry(0.95, 0.06, 0.95),
          new THREE.MeshStandardMaterial({ color: shade, roughness: 0.75, metalness: 0.2 })
        );
        tile.position.set(offset.x - 4.5 + x, 0.02, offset.z - 4.5 + y);
        tile.userData.board = board;
        tile.userData.x = x;
        tile.userData.y = y;
        group.add(tile);
        this.boardTiles.push(tile);
      }
    }
  }

  private rebuildShips(ships: ShipInstance[], hp: Map<string, number>): void {
    const keep = new Set<string>();
    for (const ship of ships) {
      if (!ship.placed) {
        continue;
      }
      keep.add(ship.uid);
      let ms = this.ships.get(ship.uid);
      if (!ms) {
        const g = new THREE.Group();
        const hull = new THREE.Mesh(
          new THREE.BoxGeometry(shipCells(ship).length * 0.9, 0.35, 0.7),
          new THREE.MeshStandardMaterial({
            color: SHIP_COLORS[ship.typeId],
            roughness: 0.5,
            metalness: 0.55,
            transparent: true,
            opacity: 1,
          })
        );
        g.add(hull);
        this.shipLayer.add(g);
        ms = { group: g, baseY: 0.24 };
        this.ships.set(ship.uid, ms);
      }

      const perc = hp.get(ship.uid) ?? 1;
      const mat = (ms.group.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
      mat.opacity = Math.max(0.25, perc);

      const width = shipCells(ship).length * 0.9;
      (ms.group.children[0] as THREE.Mesh).geometry.dispose();
      (ms.group.children[0] as THREE.Mesh).geometry = new THREE.BoxGeometry(width, 0.35, 0.7);

      const pos = this.worldForCell('own', ship.anchor);
      ms.group.position.set(pos.x + (ship.orientation === 'H' ? (shipCells(ship).length - 1) * 0.45 : 0), ms.baseY, pos.z + (ship.orientation === 'V' ? (shipCells(ship).length - 1) * 0.45 : 0));
      ms.group.rotation.y = ship.orientation === 'H' ? 0 : Math.PI / 2;
    }

    for (const [uid, ms] of this.ships) {
      if (!keep.has(uid)) {
        this.shipLayer.remove(ms.group);
        this.ships.delete(uid);
      }
    }
  }

  private rebuildMarkers(misses: Set<string>, hits: Set<string>): void {
    this.markerGroup.clear();

    for (const k of misses) {
      const [x, y] = k.split(',').map(Number);
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.12, 0.25, 16),
        new THREE.MeshBasicMaterial({ color: 0x8ba8bf, side: THREE.DoubleSide })
      );
      m.rotation.x = -Math.PI / 2;
      const p = this.worldForCell('target', { x, y });
      m.position.set(p.x, 0.16, p.z);
      this.markerGroup.add(m);
    }

    for (const k of hits) {
      const [x, y] = k.split(',').map(Number);
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0xff9a67 })
      );
      const p = this.worldForCell('target', { x, y });
      m.position.set(p.x, 0.25, p.z);
      this.markerGroup.add(m);
    }
  }

  private rebuildPreview(cells: Coord[], color: number, own?: Coord, target?: Coord): void {
    this.previewGroup.clear();
    this.selectionGroup.clear();

    for (const c of cells) {
      const p = this.worldForCell('own', c);
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(0.92, 0.07, 0.92),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 })
      );
      tile.position.set(p.x, 0.22, p.z);
      this.previewGroup.add(tile);
    }

    if (own) {
      const p = this.worldForCell('own', own);
      const sel = new THREE.Mesh(
        new THREE.RingGeometry(0.2, 0.4, 20),
        new THREE.MeshBasicMaterial({ color: 0xaed0ec, side: THREE.DoubleSide })
      );
      sel.rotation.x = -Math.PI / 2;
      sel.position.set(p.x, 0.22, p.z);
      this.selectionGroup.add(sel);
    }
    if (target) {
      const p = this.worldForCell('target', target);
      const sel = new THREE.Mesh(
        new THREE.RingGeometry(0.2, 0.4, 20),
        new THREE.MeshBasicMaterial({ color: 0xf4c188, side: THREE.DoubleSide })
      );
      sel.rotation.x = -Math.PI / 2;
      sel.position.set(p.x, 0.22, p.z);
      this.selectionGroup.add(sel);
    }
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

    for (const [, ms] of this.ships) {
      if (!ms.sunkAnim) {
        continue;
      }
      ms.sunkAnim.t += dt;
      const n = Math.min(ms.sunkAnim.t / 2.4, 1);
      ms.group.rotation.z = -n * 0.7;
      ms.group.position.y = ms.sunkAnim.startY - n * 1.4;
      const mat = (ms.group.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
      mat.opacity = Math.max(0, 1 - n);
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
}
