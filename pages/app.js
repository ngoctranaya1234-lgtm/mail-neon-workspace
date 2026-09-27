import { gmailCanonical, generateCombinedDotVariants, generateDotVariants, generatePlusVariants } from './domain.mjs';

const $ = id => document.getElementById(id);
const categoryNames = { binary: 'Thứ tự nhị phân', random: 'Xáo trộn', one_dot: '1 dấu chấm', two_dots: '2 dấu chấm', alternating: 'Xen kẽ đều' };
const state = { tool: 'dots', items: [], page: 0, job: null };
const pageSize = 100;
const format = value => new Intl.NumberFormat('vi-VN').format(value);

function announce(message, error = false) {
  $('form-status').textContent = message;
  $('form-status').classList.toggle('error', error);
}

let toastTimer;
function toast(message, error = false) {
  const element = $('toast');
  element.textContent = message;
  element.className = `visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.className = '', 3500);
}

function selectTool(tool) {
  if (state.job) state.job.cancelled = true;
  state.tool = tool;
  for (const [name, panel] of [['dots', 'dots-fields'], ['plus', 'plus-fields']]) {
    const active = name === tool;
    $(`tab-${name}`).setAttribute('aria-selected', String(active));
    $(`tab-${name}`).tabIndex = active ? 0 : -1;
    $(panel).hidden = !active;
  }
  state.items = [];
  state.page = 0;
  announce('');
  render();
}

function render() {
  const count = state.items.length;
  $('result-count').textContent = format(count);
  $('copy-all').disabled = $('download').disabled = count === 0;
  $('empty').hidden = count > 0;
  $('result-list').hidden = count === 0;
  const maxPage = Math.max(0, Math.ceil(count / pageSize) - 1);
  state.page = Math.min(state.page, maxPage);
  const list = $('result-list');
  list.replaceChildren();
  const fragment = document.createDocumentFragment();
  const start = state.page * pageSize;
  for (let i = start; i < Math.min(start + pageSize, count); i++) {
    const item = state.items[i];
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'listitem');
    const index = document.createElement('span');
    index.className = 'row-index';
    index.textContent = `#${i + 1}`;
    const body = document.createElement('div');
    body.className = 'row-body';
    const address = document.createElement('span');
    address.className = 'row-address';
    address.textContent = item.address;
    body.append(address);
    if (item.categories?.length) {
      const tags = document.createElement('div');
      tags.className = 'tags';
      for (const category of item.categories) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = categoryNames[category] || category;
        tags.append(tag);
      }
      body.append(tags);
    }
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-row';
    copy.textContent = 'Sao chép';
    copy.setAttribute('aria-label', `Sao chép ${item.address}`);
    copy.addEventListener('click', () => copyText(item.address));
    row.append(index, body, copy);
    fragment.append(row);
  }
  list.append(fragment);
  $('pager').hidden = count <= pageSize;
  $('page-label').textContent = `Trang ${state.page + 1} / ${maxPage + 1}`;
  $('previous').disabled = state.page === 0;
  $('next').disabled = state.page >= maxPage;
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    toast('Đã sao chép vào bộ nhớ tạm');
  } catch {
    toast('Trình duyệt không cho phép sao chép. Hãy chọn và sao chép thủ công.', true);
  }
}

function readEmail() {
  const email = $('email').value.trim();
  gmailCanonical(email);
  return email;
}

function runDots(email) {
  const count = $('dot-all').checked ? 'all' : Number($('dot-count').value);
  if (count !== 'all' && (!Number.isInteger(count) || count < 1 || count > 2000)) throw new Error('Mỗi lượt Dot Trick cần từ 1 đến 2.000 biến thể.');
  const useGooglemail = $('googlemail').checked;
  if ($('dot-mode').value === 'combined') {
    state.items = generateCombinedDotVariants(email, { count: count === 'all' ? 2000 : count, useGooglemail });
  } else {
    const pattern = $('dot-pattern').value;
    state.items = generateDotVariants(email, { count, mode: pattern === 'binary' ? 'all' : pattern, useGooglemail })
      .map(address => ({ address, categories: [pattern] }));
  }
  state.page = 0;
  render();
  announce(`Đã sinh ${format(state.items.length)} biến thể Dot Trick. Tất cả cùng dẫn về hộp Gmail gốc.`);
  if (!state.items.length) toast('Tên Gmail này không có vị trí để chèn dấu chấm.', true);
}

async function runPlus(email) {
  const totalText = $('plus-count').value.trim();
  if (!/^[1-9]\d*$/.test(totalText) || totalText.length > 100) throw new Error('Nhập số nguyên dương hợp lệ vào ô số lượng.');
  const total = BigInt(totalText);
  const preset = $('plus-preset').value;
  const customTag = $('plus-prefix').value.trim();
  const job = { cancelled: false };
  state.job = job;
  state.items = [];
  state.page = 0;
  $('generate').disabled = true;
  $('stop').hidden = false;
  render();
  let offset = 0n;
  try {
    while (offset < total && !job.cancelled) {
      const size = Number(total - offset > 2000n ? 2000n : total - offset);
      const page = generatePlusVariants(email, { preset, customTag, count: size, offset: offset.toString() });
      state.items.push(...page.map(address => ({ address, categories: [] })));
      offset += BigInt(size);
      render();
      announce(`Đã sinh ${format(state.items.length)} / ${totalText} thẻ Plus${job.cancelled ? ' · đã dừng' : ''}.`);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    announce(job.cancelled ? `Đã dừng sau ${format(state.items.length)} thẻ Plus.` : `Hoàn tất ${format(state.items.length)} thẻ Plus. Các địa chỉ cùng dẫn về hộp Gmail gốc.`);
  } finally {
    if (state.job === job) {
      state.job = null;
      $('generate').disabled = false;
      $('stop').hidden = true;
    }
  }
}

$('generator-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const email = readEmail();
    if (state.tool === 'dots') runDots(email);
    else await runPlus(email);
  } catch (error) {
    announce(error.message || 'Không thể sinh bí danh.', true);
    toast(error.message || 'Không thể sinh bí danh.', true);
  }
});
$('tab-dots').addEventListener('click', () => selectTool('dots'));
$('tab-plus').addEventListener('click', () => selectTool('plus'));
for (const name of ['dots', 'plus']) {
  $(`tab-${name}`).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = name === 'dots' ? 'plus' : 'dots';
    selectTool(target);
    $(`tab-${target}`).focus();
  });
}
$('dot-mode').addEventListener('change', () => $('pattern-wrap').hidden = $('dot-mode').value !== 'categorized');
$('dot-all').addEventListener('change', () => $('dot-count').disabled = $('dot-all').checked);
$('stop').addEventListener('click', () => { if (state.job) state.job.cancelled = true; });
$('copy-all').addEventListener('click', () => copyText(state.items.map(item => item.address).join('\n')));
$('download').addEventListener('click', () => {
  const text = state.items.map(item => item.categories?.length ? `${item.address}\t${item.categories.map(code => categoryNames[code] || code).join(', ')}` : item.address).join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = state.tool === 'dots' ? 'gmail-dot-trick.txt' : 'gmail-plus.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});
$('previous').addEventListener('click', () => { state.page--; render(); });
$('next').addEventListener('click', () => { state.page++; render(); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
