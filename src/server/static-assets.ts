import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_ORIGINS = [
  'https://testingcf.jsdelivr.net',
  'https://cdn.jsdmirror.com',
  'https://cdn.jsdmirror.cn',
];
const SHA = /^[a-f0-9]{40}$/;
const RESOURCE =
  /\.(?:css|js|mjs|png|jpe?g|gif|svg|ico|webp|woff2?|otf|ttf|mp3|mp4|webm|ogg|wav|json|gltf|glb|bin|hdr)$/i;
const jsonForHtml = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

/** Resolve immutable revisions once at startup, independently for each tracked file. */
export class StaticAssetDelivery {
  readonly commit: string;
  readonly enabled: boolean;
  readonly bases: string[];
  readonly commits: Record<string, string> = {};
  private readonly root: string;
  private readonly override: string;
  private readonly digests = new Map<string, string>();
  private readonly runtime: string;

  constructor(
    private readonly version: string,
    cwd = process.cwd(),
    env = process.env,
  ) {
    this.root = path.join(cwd, 'static');
    const revision = env.ROKA_STATIC_COMMIT || '';
    this.override = revision;
    if (revision && !SHA.test(revision))
      throw new Error('ROKA_STATIC_COMMIT must be a full 40-character commit SHA');
    if (!revision && env.ROKA_STATIC_CDN !== '0') {
      try {
        const tracked = new Set(
          execFileSync('git', ['ls-files', '-z', '--', 'static'], {
            cwd,
            stdio: ['ignore', 'pipe', 'ignore'],
          })
            .toString()
            .split('\0'),
        );
        const history = execFileSync(
          'git',
          [
            'log',
            '--full-history',
            '--topo-order',
            '--diff-merges=combined',
            '--format=%x00%H',
            '--name-only',
            '-z',
            '--',
            'static',
          ],
          {
            cwd,
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 64 * 1024 * 1024,
          },
        ).toString();
        const shallowPath = execFileSync('git', ['rev-parse', '--git-path', 'shallow'], {
          cwd,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
        const shallowFile = path.resolve(cwd, shallowPath);
        const shallow = new Set(
          existsSync(shallowFile) ? readFileSync(shallowFile, 'utf8').trim().split('\n') : [],
        );
        let sha = '';
        for (const token of history.split('\0')) {
          const value = token.replace(/^\n+|\n+$/g, '');
          if (SHA.test(value)) sha = shallow.has(value) ? '' : value;
          else if (sha && tracked.has(value) && value.startsWith('static/')) {
            const key = '/' + value.slice(7);
            if (!this.commits[key]) this.commits[key] = sha;
          }
        }
      } catch {
        // Archive deployments need an explicit override; unknown files stay local.
      }
    }
    this.commit = revision || Object.values(this.commits)[0] || '';
    this.enabled = env.ROKA_STATIC_CDN !== '0' && !!this.commit;
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
    if (/%|\\/.test(pathname) || pathname.split('/').some((part) => part === '..' || part === '.'))
      return null;
    if (!RESOURCE.test(pathname) || pathname.startsWith('/api/') || pathname.startsWith('/socket.io/'))
      return null;
    const filename = path.resolve(this.root, '.' + pathname);
    if (!filename.startsWith(this.root + path.sep) || !existsSync(filename)) return null;
    return filename;
  }
  url(url: string): string {
    const pathname = url.split(/[?#]/)[0];
    const commit = this.override || this.commits[pathname];
    if (!this.enabled || !commit || !this.localFile(url)) return url;
    const parsed = new URL(url, 'https://local.invalid');
    parsed.searchParams.delete('v');
    return (
      this.bases[0].replace('@' + this.commit + '/', '@' + commit + '/') +
      pathname.slice(1) +
      parsed.search +
      parsed.hash
    );
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
    if (!this.enabled || this.url('/sw.js') === '/sw.js') return source;
    const urls = this.bases.map((base) =>
      base === '/'
        ? '/sw.js?source=1'
        : base.replace('@' + this.commit + '/', '@' + (this.commits['/sw.js'] || this.commit) + '/') +
          'sw.js',
    );
    // Worker registration cannot use a cross-origin script URL. This tiny origin
    // wrapper loads the implementation from the same pinned CDN commit.
    return `/* Origin-scoped registration; implementation is commit-pinned. */\n(function(){var urls=${JSON.stringify(urls)},last;for(var i=0;i<urls.length;i++){try{importScripts(urls[i]);return;}catch(error){last=error;}}throw last;})();\n`;
  }

  html(source: string): string {
    if (!this.enabled) return source;
    const preloads: string[] = [];
    let html = source.replace(
      /<script\b([^>]*)>([\s\S]*?)<\/script(?:\s[^>]*)?>/gi,
      (tag, raw: string, body: string) => {
        const attrs: Record<string, string> = {};
        for (const match of raw.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
          attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
        if (attrs.type && !['text/javascript', 'application/javascript', 'module'].includes(attrs.type))
          return tag;
        const src = attrs.src;
        if (src && !this.localFile(src)) return tag;
        if (src && !Object.prototype.hasOwnProperty.call(attrs, 'nomodule')) {
          const escape = (value: string) =>
            value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
          const rel = attrs.type === 'module' ? 'modulepreload' : 'preload';
          const as = attrs.type === 'module' ? '' : ' as="script"';
          preloads.push(
            `<link rel="${rel}"${as} href="${escape(this.url(src))}" integrity="${this.integrity(src)}" crossorigin="${escape(attrs.crossorigin || 'anonymous')}" />`,
          );
        }
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
      const attrs: Record<string, string> = {};
      for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        if (!['href', 'integrity', 'crossorigin'].includes(match[1].toLowerCase()))
          attrs[match[1]] = match[2] ?? match[3];
      }
      return `<script>window.ROKA_ASSETS.stylesheet(${jsonForHtml(href)},${jsonForHtml(integrity)},${jsonForHtml(attrs)});</script>`;
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
    html = html.replace(
      /<script\b[^>]*>[\s\S]*?<\/script>|(["'])(\/[^\s"'<>]*)\1/gi,
      (all, q: string | undefined, url: string) => (q ? q + this.url(url) + q : all),
    );
    const config = { bases: this.bases, commit: this.commit, commits: this.commits, version: this.version };
    const initialStyle =
      '<style id="roka-initial-style">html{background:#eef1f6}body{visibility:hidden!important}html::before{content:"Roka 加载中…";position:fixed;inset:0;display:grid;place-items:center;color:#253042;font:16px sans-serif}</style>';
    const bootstrap = `${initialStyle}<script>window.ROKA_ASSET_CONFIG=${jsonForHtml(config)};\n${this.runtime.replace(/<\/script/gi, '<\\/script')}\n</script>`;
    return html.replace(/<head\b[^>]*>/i, (head) => head + bootstrap + preloads.join(''));
  }
}
