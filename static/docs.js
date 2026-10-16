// 文档页共享脚本：登录态展示 + data-goto 导航 + 可选 KaTeX 公式渲染。
// 页面只需引入本脚本，按钮加 data-goto="/path" 即可；含公式的页面需先引入
// vendor/katex/katex.min.css、katex.min.js 与 auto-render.min.js。
async function docsLoadUser() {
  const nameEl = document.getElementById('account-name');
  const loginEl = document.getElementById('login-btn');
  if (!nameEl || !loginEl) return;
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      nameEl.style.display = 'none';
      return;
    }
    const data = await res.json();
    nameEl.textContent = data.username;
    loginEl.style.display = 'none';
  } catch (err) {
    nameEl.style.display = 'none';
  }
}

function docsWireNav() {
  document.querySelectorAll('[data-goto]').forEach((el) => {
    el.addEventListener('click', () => {
      location.href = el.getAttribute('data-goto');
    });
  });
}

function docsRenderMath() {
  if (typeof renderMathInElement !== 'function') return;
  renderMathInElement(document.getElementById('app'), {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false },
    ],
    throwOnError: false,
  });
}

docsLoadUser();
docsWireNav();
docsRenderMath();
