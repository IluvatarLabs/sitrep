// Loaded before every test file (vitest.config.ts `setupFiles`); the server itself never loads it.
//
// supertest listens on the wildcard address and then connects to 127.0.0.1. On macOS a server bound to 127.0.0.1:P in another
// process wins those connections even though the wildcard bind of P also succeeds, so under load a test can be answered by someone
// else's server. Binding a bare `listen(0)` to loopback closes that gap: two binds to 127.0.0.1 cannot share a port. supertest reads
// `address().port` right after `listen(0)`, so the bind has to be synchronous, which `_listen2` (the call `listen` ends in) is.
import net from 'node:net';

type AnyListen = (this: net.Server, ...args: unknown[]) => net.Server;
/** Node's internal synchronous bind, present on every net.Server. */
type WithSyncBind = net.Server & { _listen2?: (address: string, port: number, addressType: 4 | 6, backlog: number) => void };

const nodeListen = net.Server.prototype.listen as unknown as AnyListen;

/** `listen(0)` or `listen(0, cb)` binds 127.0.0.1 at once; every other call is Node's own `listen`. */
function listenOnLoopback(this: net.Server, ...args: unknown[]): net.Server {
  const self = this as WithSyncBind;
  const ephemeralOnAnyHost = args[0] === 0 && typeof args[1] !== 'string';
  if (!ephemeralOnAnyHost || self.listening || typeof self._listen2 !== 'function') return nodeListen.apply(this, args);
  const onListening = args.find((a): a is () => void => typeof a === 'function');
  if (onListening) self.once('listening', onListening);
  self._listen2('127.0.0.1', 0, 4, 511);
  return self;
}

net.Server.prototype.listen = listenOnLoopback as typeof net.Server.prototype.listen;
