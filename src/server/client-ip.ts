import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

export const normalizeIpToken = (token: string): string | null => {
  const trimmed = token.trim().replace(/^"(.+)"$/u, '$1');
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return null;

  const strippedForPrefix = trimmed
    .replace(/^for=/iu, '')
    .trim()
    .replace(/^"(.+)"$/u, '$1');
  const bracketWrapped = strippedForPrefix.match(/^\[([^[\]]+)\](?::\d+)?$/u);
  const maybeIp = bracketWrapped ? bracketWrapped[1] : strippedForPrefix;
  const mappedSuffix = maybeIp.slice(7);
  const normalized = /^::ffff:/iu.test(maybeIp) && isIP(mappedSuffix) === 4 ? mappedSuffix : maybeIp;

  if (isIP(normalized) === 4) return normalized;
  if (isIP(normalized) === 6) {
    try {
      const canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1).toLowerCase();
      const mapped = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
      if (!mapped) return canonical;
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    } catch {
      return null;
    }
  }

  const ipv4WithPort = normalized.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/u);
  return ipv4WithPort && isIP(ipv4WithPort[1]) === 4 ? ipv4WithPort[1] : null;
};

export const isPrivateOrLoopbackIp = (ip: string): boolean => {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map((part) => Number.parseInt(part, 10));
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }

  const lowered = ip.toLowerCase();
  return (
    lowered === '::1' ||
    lowered === '::' ||
    lowered.startsWith('fc') ||
    lowered.startsWith('fd') ||
    lowered.startsWith('fe8') ||
    lowered.startsWith('fe9') ||
    lowered.startsWith('fea') ||
    lowered.startsWith('feb')
  );
};

const getRemoteIp = (request: FastifyRequest): string | null => {
  const remoteAddress = request.socket.remoteAddress;
  if (typeof remoteAddress === 'string') {
    const normalized = normalizeIpToken(remoteAddress);
    if (normalized) return normalized;
  }
  return typeof request.ip === 'string' ? normalizeIpToken(request.ip) : null;
};

export const resolveClientIp = (request: FastifyRequest): string | null => {
  const remoteIp = getRemoteIp(request);
  if (remoteIp && isPrivateOrLoopbackIp(remoteIp)) {
    const value = request.headers['x-real-ip'];
    const realIp = typeof value === 'string' ? normalizeIpToken(value) : null;
    if (realIp) return realIp;
  }
  return remoteIp;
};

export const resolveRateLimitKey = (request: FastifyRequest): string => resolveClientIp(request) ?? 'unknown';
