const repo = 'kmab5/deft-desktop';
const releasesUrl = `https://github.com/${repo}/releases`;

const themeSwitch = document.querySelector('#theme-switch');
const themeColor = document.querySelector('meta[name="theme-color"]');
const themeKey = 'deft-site-theme';

function setTheme(light) {
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  themeSwitch.setAttribute('aria-pressed', String(light));
  themeColor.content = light ? '#f4f1ea' : '#101014';
}

try {
  setTheme(localStorage.getItem(themeKey) === 'light');
} catch {
  setTheme(false);
}
themeSwitch.hidden = false;
themeSwitch.addEventListener('click', () => {
  const light = document.documentElement.dataset.theme !== 'light';
  setTheme(light);
  try {
    localStorage.setItem(themeKey, light ? 'light' : 'dark');
  } catch {
    // The current theme still works when browser storage is disabled.
  }
});

const preview = document.querySelector('.preview-tabs');
const tabs = [...preview.querySelectorAll('[role="tab"]')];

function selectPreview(selected) {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectPreview(tab));
  tab.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(tab);
    let next;
    switch (event.key) {
      case 'ArrowRight': next = (index + 1) % tabs.length; break;
      case 'ArrowLeft': next = (index - 1 + tabs.length) % tabs.length; break;
      case 'Home': next = 0; break;
      case 'End': next = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    selectPreview(tabs[next]);
    tabs[next].focus();
  });
}
preview.hidden = false;

function completeRelease(release) {
  if (!release || release.draft || typeof release.tag_name !== 'string'
      || !/^v\d+\.\d+\.\d+(?:-\d+)?$/.test(release.tag_name)
      || !Array.isArray(release.assets)) return null;

  const tag = release.tag_name;
  const prefix = `deft-${tag}-windows-x64`;
  const files = {
    setup: `${prefix}-setup.exe`,
    msi: `${prefix}.msi`,
    portable: `${prefix}-portable.zip`,
    checksums: 'SHA256SUMS.txt',
  };
  const assets = {};
  for (const [key, filename] of Object.entries(files)) {
    const url = `${releasesUrl}/download/${tag}/${filename}`;
    const asset = release.assets.find((entry) =>
      entry.name === filename && entry.state === 'uploaded' && entry.size > 0 && entry.browser_download_url === url,
    );
    if (!asset) return null;
    assets[key] = { url, size: asset.size };
  }
  return { tag, assets, prerelease: release.prerelease, published: Date.parse(release.published_at) || 0, notes: `${releasesUrl}/tag/${tag}` };
}

async function updateDownloads() {
  const status = document.querySelector('#release-status');
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Release lookup failed.');
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error('Unexpected release data.');
    const newest = releases.map(completeRelease).filter(Boolean).sort((a, b) => b.published - a.published)[0];
    if (!newest) {
      status.textContent = 'See available builds on GitHub';
      return;
    }

    status.textContent = `${newest.tag} · ${newest.prerelease ? 'Prerelease' : 'Stable'}`;
    for (const link of document.querySelectorAll('[data-package]')) {
      const asset = newest.assets[link.dataset.package];
      link.href = asset.url;
      link.querySelector('.package-arrow').textContent = '↓';
      const size = document.createElement('span');
      size.className = 'package-size';
      size.textContent = `${Math.max(1, Math.round(asset.size / 1048576))} MB`;
      link.querySelector('.package-arrow').before(size);
    }
    const notes = document.querySelector('#release-notes');
    notes.href = newest.notes;
    notes.hidden = false;
    const checksums = document.querySelector('#release-checksums');
    checksums.href = newest.assets.checksums.url;
    checksums.hidden = false;
  } catch {
    status.textContent = 'Open GitHub Releases for downloads';
  }
}

void updateDownloads();
