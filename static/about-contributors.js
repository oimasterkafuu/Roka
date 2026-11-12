function aboutContributorUrl(value, hostname) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== hostname ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function aboutContributorCard(doc, value) {
  if (!value || typeof value !== 'object') return null;
  const login = value.login;
  const contributions = value.contributions;
  if (
    typeof login !== 'string' ||
    login.length > 39 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(login) ||
    login.includes('--') ||
    !Number.isSafeInteger(contributions) ||
    contributions < 1
  ) {
    return null;
  }
  const profileUrl = aboutContributorUrl(value.html_url, 'github.com');
  if (!profileUrl || profileUrl.pathname !== `/${login}` || profileUrl.search) return null;
  const avatarUrl = aboutContributorUrl(value.avatar_url, 'avatars.githubusercontent.com');
  if (!avatarUrl || avatarUrl.pathname === '/') return null;

  const card = doc.createElement('article');
  card.className = 'contributor-card';
  const link = doc.createElement('a');
  link.href = `https://github.com/${login}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'contributor-link';

  const avatar = doc.createElement('img');
  avatar.src = avatarUrl.toString();
  avatar.alt = `${login} 的 GitHub 头像`;
  avatar.loading = 'lazy';
  avatar.decoding = 'async';
  avatar.width = 64;
  avatar.height = 64;
  avatar.referrerPolicy = 'no-referrer';

  const name = doc.createElement('span');
  name.className = 'contributor-name';
  name.textContent = login;
  const count = doc.createElement('span');
  count.className = 'contributor-count';
  count.textContent = `${contributions} 次贡献`;

  link.append(avatar, name, count);
  card.append(link);
  return card;
}

async function aboutLoadContributors() {
  const grid = document.getElementById('contributors-grid');
  const status = document.getElementById('contributors-status');
  if (!grid || !status) return;
  status.hidden = false;
  status.textContent = '正在加载贡献者名单…';
  try {
    const response = await fetch('/api/contributors', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('contributors unavailable');
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('invalid contributors response');
    const cards = data.map((item) => aboutContributorCard(document, item)).filter(Boolean);
    grid.replaceChildren(...cards);
    status.hidden = cards.length > 0;
    status.textContent = cards.length ? '' : '暂无公开展示的贡献者信息。';
  } catch {
    grid.replaceChildren();
    status.hidden = false;
    status.textContent = '暂时无法加载贡献者名单，请稍后通过下方 GitHub 链接查看。';
  }
}

if (typeof document !== 'undefined') {
  var aboutContributorsReady = aboutLoadContributors();
}
