function featurePanel(title, content, className = '') {
  return '<section class="feature-panel ' + className + '"><h3>' + escapeHtml(title) + '</h3>' + content + '</section>';
}
document.addEventListener('click', event => {
  const tab = event.target.closest('[data-feature-tab]');
  if (tab) selectFeatureTab(tab);
});
function selectFeatureTab(button, focus = false) {
  for (const tab of button.parentElement.querySelectorAll('[data-feature-tab]')) {
    const active = tab === button;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).classList.toggle('hidden', !active);
  }
  if (focus) button.focus();
}
document.addEventListener('keydown', event => {
  const tab = event.target.closest('[data-feature-tab]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...tab.parentElement.querySelectorAll('[data-feature-tab]')];
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  selectFeatureTab(tabs[index], true);
});
