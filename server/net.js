import os from 'node:os';
import dgram from 'node:dgram';

// Adapters that are rarely reachable from a phone or laptop on the same Wi-Fi.
const VIRTUAL = /(vEthernet|VirtualBox|VMware|Hyper-V|WSL|Docker|vboxnet|vmnet|^br-|^veth|utun|Tailscale|ZeroTier|Loopback|Bluetooth|isatap|Teredo)/i;

export function normIp(addr) {
  if (!addr) return '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/** True when the request comes from this machine (loopback or any of its own addresses). */
export function isLocalAddress(addr) {
  const ip = normIp(addr);
  if (ip === '::1' || ip.startsWith('127.')) return true;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (normIp(a.address) === ip) return true;
  }
  return false;
}

export function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || hostname.startsWith('127.');
}

let routeAddress = null;

/** The local address the OS would use for outbound traffic — almost always the Wi-Fi/LAN one. */
export function refreshRouteAddress() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (value) => {
      try {
        sock.close();
      } catch {}
      if (value) routeAddress = value;
      resolve(routeAddress);
    };
    sock.on('error', () => done(null));
    try {
      // connect() on UDP sends nothing; it only asks the OS to pick a route.
      sock.connect(53, '8.8.8.8', () => {
        try {
          done(sock.address().address);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}

function score(a) {
  let s = 0;
  if (a.address === routeAddress) s += 100;
  if (!VIRTUAL.test(a.name)) s += 20;
  if (a.address.startsWith('192.168.')) s += 10;
  else if (a.address.startsWith('10.')) s += 8;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) s += 6;
  if (a.address.startsWith('169.254.')) s -= 60;
  return s;
}

/** LAN addresses of this machine, best first. */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out.sort((a, b) => score(b) - score(a)).map((a) => ({ ...a, virtual: VIRTUAL.test(a.name) }));
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * DNS-rebinding guard: only answer to IP literals, localhost and LAN-style names
 * (single-label hostnames, .local, .lan, .home, .internal).
 */
export function isAllowedHost(hostHeader) {
  if (!hostHeader) return true;
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) return true; // IPv6 literal
  host = host.replace(/:\d+$/, '');
  if (IPV4.test(host) || host === 'localhost') return true;
  if (!host.includes('.')) return true;
  return /\.(local|lan|home|internal|home\.arpa|localdomain)$/.test(host);
}
