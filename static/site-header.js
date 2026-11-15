function siteHeaderShowGuest() {
  var nameEl = document.getElementById('site-account-name');
  var loginEl = document.getElementById('site-login');
  var logoutEl = document.getElementById('site-logout');
  if (nameEl) nameEl.hidden = true;
  if (loginEl) loginEl.hidden = false;
  if (logoutEl) logoutEl.hidden = true;
}

async function siteHeaderLoadUser() {
  var nameEl = document.getElementById('site-account-name');
  var loginEl = document.getElementById('site-login');
  var logoutEl = document.getElementById('site-logout');
  if (!nameEl || !loginEl || !logoutEl) return false;

  logoutEl.addEventListener('click', async function () {
    logoutEl.disabled = true;
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      location.href = '/login';
    } catch (error) {
      logoutEl.disabled = false;
    }
  });

  try {
    var response = await fetch('/api/auth/me', { cache: 'no-store' });
    if (!response.ok) {
      siteHeaderShowGuest();
      return false;
    }
    var data = await response.json();
    if (!data || typeof data.username !== 'string' || !data.username) {
      siteHeaderShowGuest();
      return false;
    }
    var component = usernameLink(data.username, null, 'site-account-name')[0];
    component.id = nameEl.id;
    nameEl.replaceWith(component);
    component.hidden = false;
    loginEl.hidden = true;
    logoutEl.hidden = false;
    usernameEnsureColors([data.username]);
    return true;
  } catch (error) {
    siteHeaderShowGuest();
    return false;
  }
}

var siteHeaderReady = siteHeaderLoadUser();
