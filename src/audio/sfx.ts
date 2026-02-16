export type SfxName = 'cannon' | 'explosion' | 'splash' | 'move' | 'sink';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private enabled = false;
  private volume = 0.7;

  isEnabled(): boolean {
    return this.enabled;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) {
      this.master.gain.value = this.volume;
    }
  }

  async enable(): Promise<void> {
    if (this.enabled) {
      return;
    }
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!Ctx) {
      // No audio support
      return;
    }
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.12;

    this.master.connect(this.compressor);
    this.compressor.connect(this.ctx.destination);

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
    if (this.ctx) {
      void this.ctx.close();
    }
    this.ctx = null;
    this.master = null;
    this.compressor = null;
  }

  play(name: SfxName, intensity = 1): void {
    if (!this.enabled || !this.ctx || !this.master) {
      return;
    }
    const t = this.ctx.currentTime;
    switch (name) {
      case 'cannon':
        this.playCannon(t, intensity);
        return;
      case 'explosion':
        this.playExplosion(t, intensity);
        return;
      case 'splash':
        this.playSplash(t, intensity);
        return;
      case 'move':
        this.playMove(t, intensity);
        return;
      case 'sink':
        this.playSink(t, intensity);
        return;
    }
  }

  private noiseBuffer(seconds: number): AudioBuffer {
    const frames = Math.max(1, Math.floor(seconds * this.ctx!.sampleRate));
    const buf = this.ctx!.createBuffer(1, frames, this.ctx!.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  private playCannon(t: number, intensity: number): void {
    const ctx = this.ctx!;

    // Punchy transient (click)
    const click = ctx.createOscillator();
    const clickGain = ctx.createGain();
    click.type = 'square';
    click.frequency.setValueAtTime(220 + Math.random() * 30, t);
    clickGain.gain.setValueAtTime(0.0001, t);
    clickGain.gain.exponentialRampToValueAtTime(0.7 * intensity, t + 0.002);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    click.connect(clickGain);
    clickGain.connect(this.master!);
    click.start(t);
    click.stop(t + 0.04);

    // Thump body
    const thump = ctx.createOscillator();
    const thumpGain = ctx.createGain();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(90 + Math.random() * 10, t);
    thump.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    thumpGain.gain.setValueAtTime(0.0001, t);
    thumpGain.gain.exponentialRampToValueAtTime(0.9 * intensity, t + 0.01);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    thump.connect(thumpGain);
    thumpGain.connect(this.master!);
    thump.start(t);
    thump.stop(t + 0.25);

    // Short noise burst (smoke)
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.08);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(1400, t);
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.0001, t);
    nGain.gain.exponentialRampToValueAtTime(0.35 * intensity, t + 0.005);
    nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(filt);
    filt.connect(nGain);
    nGain.connect(this.master!);
    src.start(t);
  }

  private playExplosion(t: number, intensity: number): void {
    const ctx = this.ctx!;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.25);

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(160, t);
    band.Q.setValueAtTime(0.9, t);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.1 * intensity, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);

    src.connect(band);
    band.connect(lp);
    lp.connect(g);
    g.connect(this.master!);

    src.start(t);
  }

  private playSplash(t: number, intensity: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.18);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(600, t);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.45 * intensity, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);

    src.connect(hp);
    hp.connect(g);
    g.connect(this.master!);

    src.start(t);
  }

  private playMove(t: number, intensity: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(420 + Math.random() * 60, t);
    o.frequency.exponentialRampToValueAtTime(220, t + 0.12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18 * intensity, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g);
    g.connect(this.master!);
    o.start(t);
    o.stop(t + 0.16);
  }

  private playSink(t: number, intensity: number): void {
    const ctx = this.ctx!;
    // Downward "glug" sweep
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.55);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22 * intensity, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    o.connect(g);
    g.connect(this.master!);
    o.start(t);
    o.stop(t + 0.75);

    // Bubbles
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(480, t);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.12 * intensity, t + 0.02);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    src.connect(lp);
    lp.connect(ng);
    ng.connect(this.master!);
    src.start(t);
  }
}

export const sfx = new Sfx();
