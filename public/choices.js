/* Keep all available values visible, while retaining each field's existing value contract. */
const choiceControls = new WeakMap();
function refreshChoices(root = document) {
  for (const select of root.querySelectorAll('select')) {
    let group = choiceControls.get(select);
    if (!group) {
      group = document.createElement('div');
      group.className = 'choice-control';
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', select.getAttribute('aria-label') || select.closest('label')?.firstChild?.textContent.trim() || (select.id && document.querySelector('label[for="' + select.id + '"]')?.textContent) || '选择选项');
      select.classList.add('choice-source');
      select.tabIndex = -1;
      select.setAttribute('aria-hidden', 'true');
      select.after(group);
      choiceControls.set(select, group);
      group.addEventListener('click', event => {
        const button = event.target.closest('[data-choice-value]');
        if (!button || button.disabled) return;
        event.preventDefault();
        const scope = select.closest('.unified-rule-editor, .generated-plan-editor') || select.parentElement;
        const key = select.dataset.unifiedKey || select.dataset.planKey;
        select.value = button.dataset.choiceValue;
        updateChoice(select, group);
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (!select.isConnected && key && scope.isConnected) {
          refreshChoices(scope);
          const replacement = [...scope.querySelectorAll('select')].find(field => (field.dataset.unifiedKey || field.dataset.planKey) === key);
          choiceControls.get(replacement)?.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
        }
      });
      group.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...group.querySelectorAll('button:not(:disabled)')];
        if (!buttons.length) return;
        const current = buttons.indexOf(event.target);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next].focus();
        buttons[next].click();
      });
    }
    const options = [...select.options];
    const signature = JSON.stringify(options.map(option => [option.value, option.textContent, option.disabled]));
    if (group.dataset.options !== signature) {
      group.replaceChildren(...options.map(option => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'radio');
        button.dataset.choiceValue = option.value;
        button.textContent = option.textContent;
        return button;
      }));
      group.dataset.options = signature;
    }
    updateChoice(select, group);
  }
}
function updateChoice(select, group) {
  if (!group) return;
  [...group.children].forEach((button, index) => {
    const selected = select.selectedIndex === index;
    const checked = String(selected);
    if (button.getAttribute('aria-checked') !== checked) button.setAttribute('aria-checked', checked);
    button.tabIndex = selected ? 0 : -1;
    button.disabled = select.disabled || select.options[index]?.disabled;
  });
}
let choiceRefreshQueued = false;
new MutationObserver(records => {
  if (!records.some(record => record.type === 'childList' || record.target.matches?.('select, option')) || choiceRefreshQueued) return;
  choiceRefreshQueued = true;
  queueMicrotask(() => { choiceRefreshQueued = false; refreshChoices(); });
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
document.addEventListener('input', event => {
  if (event.target.matches('select')) updateChoice(event.target, choiceControls.get(event.target));
});
refreshChoices();
