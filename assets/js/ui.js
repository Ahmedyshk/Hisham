/**
 * Shared chrome: theme toggle, the mobile navigation menu, and installing the
 * site as an app. Loaded by every page. The initial theme is applied by a tiny
 * blocking script in <head> so the page never flashes the wrong palette.
 */

const THEME_KEY = 'difrana:theme';

/** Light unless the visitor has explicitly switched to dark. The OS setting is ignored. */
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Point the toggle at whatever switching would do next. Never writes state. */
function syncThemeButton(button) {
  if (!button) return;
  const toDark = currentTheme() === 'light';
  button.setAttribute('aria-label', toDark ? 'تفعيل الوضع الداكن' : 'تفعيل الوضع الفاتح');
  button.setAttribute('title', toDark ? 'الوضع الداكن' : 'الوضع الفاتح');
  button.querySelector('use')?.setAttribute('href', toDark ? '#i-moon' : '#i-sun');
}

/** Only ever called from the toggle: this is the one place that persists. */
function setTheme(theme, button) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'dark' ? '#0c1a2b' : '#223e5b',
  );
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage unavailable - the choice simply will not persist */
  }
  syncThemeButton(button);
}

function initTheme() {
  const button = document.getElementById('themeToggle');
  if (!button) return;

  syncThemeButton(button);

  button.addEventListener('click', () => {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark', button);
  });
}

function initNav() {
  const toggle = document.getElementById('navToggle');
  const nav = document.getElementById('primaryNav');
  if (!toggle || !nav) return;

  const desktop = window.matchMedia('(min-width: 720px)');

  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'إغلاق قائمة التنقل' : 'فتح قائمة التنقل');
    nav.classList.toggle('nav--open', open);
    toggle.querySelector('use')?.setAttribute('href', open ? '#i-close' : '#i-menu');
  };

  setOpen(false);

  toggle.addEventListener('click', () => {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });

  nav.addEventListener('click', (event) => {
    if (event.target.closest('a, button') && !desktop.matches) setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (desktop.matches || toggle.getAttribute('aria-expanded') !== 'true') return;
    if (!nav.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  });

  desktop.addEventListener('change', () => setOpen(false));
}

/* -------------------------------------------------------------------------- */
/* Install as an app                                                           */
/*                                                                             */
/* Chrome, Edge and Samsung Internet (Android and desktop) fire                 */
/* `beforeinstallprompt`; the event is held and replayed from our own button.   */
/* iOS Safari has no such event, so there the button opens a two-step hint      */
/* instead ("Share → Add to Home Screen"). Every trigger stays hidden wherever  */
/* installing is impossible or already done.                                   */
/* -------------------------------------------------------------------------- */

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function isIosSafari() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

function showIosHint() {
  if (document.getElementById('installHint')) return;
  const hint = document.createElement('div');
  hint.className = 'install-hint';
  hint.id = 'installHint';
  hint.setAttribute('role', 'dialog');
  hint.setAttribute('aria-labelledby', 'installHintTitle');
  hint.innerHTML = `
    <div class="install-hint__head">
      <img src="assets/img/mark-144.webp" alt="" width="144" height="144" />
      <p class="install-hint__title" id="installHintTitle">ثبّت الموقع على جهازك</p>
      <button type="button" class="icon-btn install-hint__close" aria-label="إغلاق">
        <svg class="icon icon--lg" aria-hidden="true"><use href="#i-close" /></svg>
      </button>
    </div>
    <ol>
      <li>اضغط زر <strong>المشاركة</strong> في شريط Safari.</li>
      <li>اختر <strong>«إضافة إلى الشاشة الرئيسية»</strong> ثم «إضافة».</li>
    </ol>`;
  const close = () => {
    hint.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  hint.querySelector('.install-hint__close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(hint);
  hint.querySelector('.install-hint__close').focus();
}

function initInstall() {
  const triggers = Array.from(document.querySelectorAll('[data-install]'));
  if (!triggers.length || isStandalone()) return;

  let deferred = null;
  const show = (visible) => triggers.forEach((node) => (node.hidden = !visible));

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    show(true);
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    show(false);
  });

  if (isIosSafari()) show(true);

  triggers.forEach((node) =>
    node.addEventListener('click', async () => {
      if (deferred) {
        deferred.prompt();
        const { outcome } = await deferred.userChoice.catch(() => ({ outcome: 'dismissed' }));
        if (outcome === 'accepted') show(false);
        deferred = null;
      } else if (isIosSafari()) {
        showIosHint();
      }
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Offline support                                                             */
/* -------------------------------------------------------------------------- */

function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Only where the browser allows it, and never against the local preview's
  // file:// fallback.
  if (!window.isSecureContext || location.protocol === 'file:') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline support is an enhancement; the site works without it */
    });
  });
}

initTheme();
initNav();
initInstall();
initServiceWorker();
