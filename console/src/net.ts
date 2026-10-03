// Two WebSockets per console: Airspace DO (traffic, advisories) and SafetyNet DO (alerts).
// Alerts keep arriving even if the agent runtime is switched off or fails.
import type { ClientMessage, ServerMessage } from '../../src/shared/types';
import type { Store } from './store';
import { toast } from './util';

class Socket {
  private ws?: WebSocket;
  private closed = false;
  private retry = 0;
  private queue: string[] = [];

  constructor(private url: string, private onMessage: (m: ServerMessage) => void, private onState: (up: boolean) => void) {
    this.open();
  }

  private open() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onState(true);
      for (const q of this.queue.splice(0)) ws.send(q);
    };
    ws.onmessage = (e) => {
      try { this.onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); }
    };
    ws.onclose = (e) => {
      this.onState(false);
      if (this.closed) return;
      if (e.code === 1008 || e.code === 4004) return;
      setTimeout(() => this.open(), Math.min(10_000, 500 * 2 ** this.retry++));
    };
  }

  send(msg: unknown) {
    const data = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else this.queue.push(data);
  }

  close() {
    this.closed = true;
    this.ws?.close(1000);
  }
}

export class Connection {
  private airspace: Socket;
  private safety: Socket;
  private onOpenHook: () => void;

  constructor(private store: Store, onOpen: () => void) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const base = `${proto}://${location.host}`;
    const name = encodeURIComponent(store.name);
    this.onOpenHook = onOpen;
    this.airspace = new Socket(`${base}/ws/airspace/${store.session}?name=${name}`, (m) => {
      if (m.type === 'error') toast(m.message);
      store.apply(m, 'airspace');
    }, (up) => {
      store.connected.airspace = up;
      store.emit('connection');
      if (up) this.onOpenHook();
    });
    this.safety = new Socket(`${base}/ws/safety/${store.session}`, (m) => store.apply(m, 'safety'), (up) => {
      store.connected.safety = up;
      store.emit('connection');
    });
  }

  send(msg: ClientMessage) {
    this.airspace.send(msg);
  }

  ackAlert(id: string, source: 'safety' | 'airspace') {
    (source === 'safety' ? this.safety : this.airspace).send({ v: 1, type: 'alert.ack', id });
  }

  close() {
    this.airspace.close();
    this.safety.close();
  }
}
