import './style.css';
import { Engine } from './render/engine';
import { Game } from './game/game';

async function main() {
  const loading = document.createElement('div');
  loading.id = 'loading';
  loading.innerHTML = '<div class="wordmark">ROADSTER</div><div class="bar"><div></div></div><div class="msg">Starting renderer</div>';
  document.body.append(loading);
  const bar = loading.querySelector<HTMLDivElement>('.bar div')!;
  const msg = loading.querySelector<HTMLDivElement>('.msg')!;
  const progress = (p: number, m: string) => {
    bar.style.width = `${Math.round(p * 100)}%`;
    msg.textContent = m;
  };

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  canvas.tabIndex = 0;
  try {
    const engine = new Engine(canvas);
    await engine.init();
    progress(0.05, `${engine.backend} renderer ready`);
    const game = new Game(engine);
    await game.init(progress);
    (window as unknown as { game: Game }).game = game;
    loading.style.opacity = '0';
    setTimeout(() => loading.remove(), 900);
  } catch (err) {
    console.error(err);
    msg.textContent = `Could not start: ${(err as Error).message}`;
  }
}

main();
