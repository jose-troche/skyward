// SKYWARD Lite console entry: hash routes  #/  (lobby)  #/s/CODE  (console)  #/replay/CODE
import { mountConsole } from './consoleView';
import { mountLobby } from './lobbyView';
import { mountReplay } from './replayView';
import { storage } from './util';

const root = document.getElementById('app')!;
let unmount: (() => void) | undefined;

const theme = storage.get('skyward.theme');
if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);

function route() {
  unmount?.();
  const hash = location.hash.replace(/^#/, '');
  let m = hash.match(/^\/s\/([A-Za-z0-9]{4,8})$/);
  if (m) {
    const name = storage.get('skyward.name') ?? 'controller';
    unmount = mountConsole(root, m[1].toUpperCase(), name);
    document.title = `SKYWARD Lite · ${m[1].toUpperCase()}`;
    return;
  }
  m = hash.match(/^\/replay\/([A-Za-z0-9]{4,8})$/);
  if (m) {
    unmount = mountReplay(root, m[1].toUpperCase());
    document.title = `SKYWARD Replay · ${m[1].toUpperCase()}`;
    return;
  }
  document.title = 'SKYWARD Lite';
  unmount = mountLobby(root, (code) => { location.hash = `#/s/${code}`; });
}

window.addEventListener('hashchange', route);
route();
