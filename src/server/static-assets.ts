import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_ORIGINS = [
  'https://cdn.jsdmirror.com',
  'https://cdn.jsdmirror.cn',
  'https://testingcf.jsdelivr.net',
];
const SHA = /^[a-f0-9]{40}$/;
const RESOURCE =
  /\.(?:css|js|mjs|png|jpe?g|gif|svg|ico|webp|woff2?|otf|ttf|mp3|mp4|webm|ogg|wav|json|gltf|glb|bin|hdr)$/i;
const jsonForHtml = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

/** A deployment pins the last committed static tree, never a moving branch/tag. */
export class StaticAssetDelivery {
  readonly commit: string;
  readonly enabled: boolean;
  readonly bases: string[];
  private readonly root: string;
  private readonly digests = new Map<string, string>();
  private readonly runtime: string;

  constructor(
    private readonly version: string,
    cwd = process.cwd(),
    env = process.env,
  ) {
    this.root = path.join(cwd, 'static');
    let revision = env.ROKA_STATIC_COMMIT || '';
    let clean = true;
    if (revision && !SHA.test(revision))
      throw new Error('ROKA_STATIC_COMMIT must be a full 40-character commit SHA');
    if (!revision) {
      try {
        revision = execFileSync('git', ['log', '-1', '--format=%H', '--', 'static'], {
          cwd,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
        clean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'static'], {
          cwd,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
      } catch {
        clean = false;
      }
    }
    this.commit = SHA.test(revision) ? revision : '';
    this.enabled = env.ROKA_STATIC_CDN !== '0' && !!this.commit && (clean || env.ROKA_STATIC_CDN === '1');
    const origins = (env.ROKA_STATIC_CDN_ORIGINS || DEFAULT_ORIGINS.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.bases = origins.map((origin) => {
      const u = new URL(origin);
      if (
        u.protocol !== 'https:' &&
        !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      )
        throw new Error('Static CDN origins require HTTPS (loopback HTTP is allowed for tests)');
      if (u.username || u.password || u.search || u.hash || u.pathname !== '/')
        throw new Error('Static CDN origins must contain only scheme and host');
      return `${u.origin}/gh/oimasterkafuu/Roka@${this.commit}/static/`;
    });
    // The application origin is only a last-resort network/SRI failure fallback.
    this.bases.push('/');
    this.runtime = readFileSync(path.join(this.root, 'asset-runtime.js'), 'utf8');
  }

  private localFile(url: string): string | null {
    if (!url.startsWith('/') || url.startsWith('//')) return null;
    const pathname = url.split(/[?#]/)[0];
    if (!RESOURCE.test(pathname) || pathname.startsWith('/api/') || pathname.startsWith('/socket.io/'))
      return null;
    const filename = path.resolve(this.root, '.' + pathname);
    if (!filename.startsWith(this.root + path.sep) || !existsSync(filename)) return null;
    return filename;
  }
  url(url: string): string {
    return this.enabled && this.localFile(url) ? this.bases[0] + url.slice(1) : url;
  }
  private integrity(url: string): string | undefined {
    const filename = this.localFile(url);
    if (!filename) return undefined;
    let value = this.digests.get(filename);
    if (!value) {
      value = 'sha384-' + createHash('sha384').update(readFileSync(filename)).digest('base64');
      this.digests.set(filename, value);
    }
    return value;
  }

  worker(source: string): string {
    if (!this.enabled) return source;
    const urls = this.bases.map((base) => (base === '/' ? '/sw.js?source=1' : base + 'sw.js'));
    // Worker registration cannot use a cross-origin script URL. This tiny origin
    // wrapper loads the implementation from the same pinned CDN commit.
    return `/* Origin-scoped registration; implementation is commit-pinned. */\n(function(){var urls=${JSON.stringify(urls)},last;for(var i=0;i<urls.length;i++){try{importScripts(urls[i]);return;}catch(error){last=error;}}throw last;})();\n`;
  }

  html(source: string): string {
    if (!this.enabled) return source;
    let html = source.replace(
      /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
      (tag, raw: string, body: string) => {
        const attrs: Record<string, string> = {};
        for (const match of raw.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
          attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
        if (attrs.type && !['text/javascript', 'application/javascript', 'module'].includes(attrs.type))
          return tag;
        const src = attrs.src;
        if (src && !this.localFile(src)) return tag;
        delete attrs.src;
        delete attrs.integrity;
        const descriptor = src ? { src, attrs, integrity: this.integrity(src) } : { attrs };
        return `<script>window.ROKA_ASSETS.enqueue(${jsonForHtml(descriptor)}${src ? '' : ',' + jsonForHtml(body)});</script>`;
      },
    );
    html = html.replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/\brel=["']stylesheet["']/i.test(tag)) return tag;
      const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
      const integrity = href && this.integrity(href);
      if (!integrity) return tag;
      return tag
        .replace(/\s+(?:integrity|crossorigin)=["'][^"']*["']/gi, '')
        .replace(/\s*\/?>$/, ` integrity="${integrity}" crossorigin="anonymous" />`);
    });
    html = html.replace(
      /\bsrcset=(["'])(.*?)\1/gi,
      (_all, quote: string, value: string) =>
        `srcset=${quote}${value
          .split(',')
          .map((part) => part.trim().replace(/^(\S+)/, (url) => this.url(url)))
          .join(', ')}${quote}`,
    );
    // Includes src/href and literal static paths in inline styles. Script bodies
    // are already encoded descriptors; their src remains a canonical local path.
    html = html.replace(/(["'])(\/[^\s"'<>]*)\1/g, (_all, q: string, url: string) => q + this.url(url) + q);
    const config = { bases: this.bases, commit: this.commit, version: this.version };
    const bootstrap = `<script>window.ROKA_ASSET_CONFIG=${jsonForHtml(config)};\n${this.runtime.replace(/<\/script/gi, '<\\/script')}\n</script>`;
    return html.replace(/<head\b[^>]*>/i, (head) => head + bootstrap);
  }
}
