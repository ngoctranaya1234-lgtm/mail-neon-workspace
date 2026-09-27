const app = document.querySelector('#app');
const toastBox = document.querySelector('#toast');

const state = {
  config: null,
  user: null,
  csrf: null,
  autoSession: false,
  page: 'generator', // Tab mặc định là công cụ sinh mail
  selectedMessage: null,
  unreadOnly: false,
  search: '',
  aliasSearch: '',
  preview: [],
  editAliasId: null,
  generatorTab: 'dots', // 'dots' | 'plus' | 'temp'
  lastPlusPreset: 'social',
  lastDotCount: '50',
  dotMode: 'combined',
  dotPattern: 'one_dot',
  dotUseGooglemail: false,
  generatedDots: [],
  generatedDotsInfo: null,
  generatedPlus: [],
  plusCount: '20',
  plusPage: 0,
  plusJob: null,
  mailboxes: [],
  autoRefreshInterval: null,
  systemMetrics: null,
  telemetryTimer: null,
  lastActionMessage: 'Chưa có thao tác mới',
  loadtest: {
    running: false,
    mode: 'generator', // 'generator' | 'http_burst' | 'sqlite_batch'
    targetCount: 10000,
    concurrency: 20,
    rps: 0,
    avgLatency: 0,
    successRate: 100,
    processed: 0,
    progress: 0,
    logs: [
      `[${new Date().toLocaleTimeString()}] Sẵn sàng kiểm tra tải trọng cao. Chọn chế độ và nhấn 'Bắt đầu kiểm tra'.`
    ],
    sparkline: [2.1, 1.8, 1.4, 1.9, 1.2, 0.9, 0.8, 1.1, 0.7, 0.8],
    lastReport: null
  }
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fmt = value => value ? new Intl.DateTimeFormat('vi-VN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)) : 'Chưa có';
const localInputDate = value => { if(!value)return '';const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16); };
const providerName = value => ({google:'Gmail',microsoft:'Outlook / Hotmail',imap:'IMAP TLS',domain:'Domain riêng'}[value] || value);
const dotCategoryName = value => ({binary:'Tất cả tổ hợp',random:'Xáo trộn ngẫu nhiên',one_dot:'1 dấu chấm',two_dots:'2 dấu chấm',alternating:'Xen kẽ đều'}[value] || value);
const canonicalGmail = value => {
  const [local,domain]=String(value||'').trim().toLowerCase().split('@');
  return local && ['gmail.com','googlemail.com'].includes(domain) ? `${local.split('+')[0].replaceAll('.','')}@gmail.com` : '';
};
const matchingGmailMailbox = () => state.mailboxes.find(box => box.provider==='google' && box.capabilities?.aliases?.includes('dot') && canonicalGmail(box.address)===canonicalGmail(state.lastDotEmail));

const audioCtx = {
  ctx: null,
  enabled: localStorage.getItem('mailneon_sound') !== '0',
  init() {
    if (!this.ctx && typeof AudioContext !== 'undefined') {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  },
  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('mailneon_sound', this.enabled ? '1' : '0');
    return this.enabled;
  },
  play(type) {
    if (!this.enabled) return;
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      if (type === 'click') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(440, now + 0.05);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        osc.start(now);
        osc.stop(now + 0.05);
      } else if (type === 'success') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.07);
        gain.gain.setValueAtTime(0.09, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.start(now);
        osc.stop(now + 0.18);
      } else if (type === 'laser') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1400, now);
        osc.frequency.exponentialRampToValueAtTime(320, now + 0.12);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.12);
      } else if (type === 'zap') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(500, now);
        osc.frequency.exponentialRampToValueAtTime(70, now + 0.22);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.22);
      }
    } catch {}
  }
};

async function refreshTelemetry() {
  try {
    const data = await api('/system/metrics', { auth: false });
    state.systemMetrics = data;
    const ramEl = document.querySelector('#hud-ram');
    if (ramEl) ramEl.textContent = `${data.memory.heapUsedMB} MB`;
    const uptimeEl = document.querySelector('#hud-uptime');
    if (uptimeEl) {
      const u = data.uptime;
      const mins = Math.floor(u / 60);
      const hrs = Math.floor(mins / 60);
      uptimeEl.textContent = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m ${u % 60}s`;
    }
    const countEl = document.querySelector('#hud-counts');
    if (countEl) countEl.textContent = `${data.counts.aliases} biến thể · ${data.counts.messages} thư`;
  } catch {}
}

function logTicker(msg) {
  state.lastActionMessage = msg;
  const el = document.querySelector('#ticker-msg');
  if (el) el.textContent = `⚡ [${new Date().toLocaleTimeString()}] ${msg}`;
}

function statusStrip(tag, left, right='') {
  return `
    <div class="status-strip">
      <span class="status-tag-live"><span class="status-dot-pulse"></span> ${esc(tag)}</span>
      <span>${esc(left)}</span>
      ${right ? `<span class="desktop-only" style="color:var(--text-muted)">${esc(right)}</span>` : ''}
    </div>`;
}

async function api(path, {method='GET', body, auth=true}={}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && !['GET','HEAD'].includes(method)) headers['X-CSRF-Token'] = state.csrf || '';
  const response = await fetch('/api/v1' + path, {
    method, headers, credentials:'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error('Máy chủ trả về dữ liệu không hợp lệ'); }
  if (!response.ok) {
    const message=payload.error?.message || 'HTTP ' + response.status;
    const requestId=payload.error?.request_id;
    throw new Error(response.status>=500 && requestId ? `${message} (mã lỗi ${requestId})` : message);
  }
  return payload.data;
}

function toast(message, isError=false) {
  toastBox.textContent = message;
  toastBox.className = `visible ${isError ? 'error' : ''}`;
  clearTimeout(toastBox._timer);
  toastBox._timer = setTimeout(() => { toastBox.className = ''; }, 3200);
}

function empty(title, description, action='') {
  return `<div class="empty"><div class="empty-icon" aria-hidden="true">✉</div><strong>${esc(title)}</strong><span>${esc(description)}</span>${action}</div>`;
}

function shell() {
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">⚡</span>
          <span>Mail Neon<br><span style="font-size:0.72rem;font-weight:700;color:var(--neon-cyan);letter-spacing:0.1em;text-transform:uppercase">Power Generator</span></span>
        </div>
        <nav class="nav" aria-label="Điều hướng chính">
          <button data-page="generator" aria-label="Sinh Dot Trick và biến thể"><span class="icon" aria-hidden="true">⚡</span><span>Sinh Dot Trick & Biến thể</span></button>
          <button data-page="inbox" aria-label="Hộp thư và OTP"><span class="icon" aria-hidden="true">✉</span><span>Hộp thư & OTP <span class="pulse-radar" style="margin-left:4px" title="Đang lắng nghe trực tiếp"></span></span></button>
          <button data-page="aliases" aria-label="Địa chỉ & Mail tạm"><span class="icon" aria-hidden="true">◈</span><span><span class="desktop-only">Danh sách </span>Mail đã tạo</span></button>
          <button data-page="connections" aria-label="Kết nối và Inbound"><span class="icon" aria-hidden="true">⌁</span><span>Kết nối & Inbound</span></button>
          <button data-page="loadtest" aria-label="Kiểm tra tải"><span class="icon" aria-hidden="true">🚀</span><span>Load Test & Stress Lab</span></button>
          <button data-page="settings" aria-label="Cài đặt"><span class="icon" aria-hidden="true">⚙</span><span>Cài đặt</span></button>
        </nav>
        <div class="side-bottom">
          <div class="small muted">Trạng thái hệ thống</div>
          <strong style="color:var(--neon-emerald)">● Ứng dụng đang chạy</strong><br>
          <span class="small muted">${esc(state.user?.email || 'local@workspace')}</span><br>
          ${state.autoSession?'<span class="small muted">Đăng nhập tự động trên máy này</span>':'<button data-action="logout" style="margin-top:4px">Đăng xuất</button>'}
        </div>
      </aside>
      <div class="main">
        <div class="cyber-hud-bar">
          <div class="hud-telemetry">
            <span class="hud-item"><span class="status-dot-pulse"></span> <span class="hud-key">HỆ THỐNG:</span> <span class="hud-val good" id="hud-uptime">ONLINE</span></span>
            <span class="hud-item"><span class="hud-key">RAM V8:</span> <span class="hud-val highlight" id="hud-ram">-- MB</span></span>
            <span class="hud-item"><span class="hud-key">CSDL:</span> <span class="hud-val" id="hud-counts">SQLITE WAL</span></span>
            <span class="hud-item desktop-only"><span class="hud-key">SMTP:</span> <span class="hud-val good">${state.config?.smtpEnabled?`CỔNG ${esc(state.config.smtpPort)}`:'TẮT'}</span></span>
            <span class="hud-item desktop-only"><span class="hud-key">LUỒNG:</span> <span class="equalizer"><span class="equalizer-bar"></span><span class="equalizer-bar"></span><span class="equalizer-bar"></span><span class="equalizer-bar"></span></span></span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <button class="btn small sound-btn" id="btn-sound-toggle" data-action="toggle-sound" style="min-height:26px;padding:3px 10px;font-size:0.75rem;border-color:var(--neon-purple);background:rgba(217,70,239,0.12);color:#fff;font-weight:700" title="Bật/Tắt âm thanh hiệu ứng Cyberpunk">${audioCtx.enabled?'🔊 SFX':'🔇 MUTE'}</button>
            <button class="btn small clean-btn" style="min-height:26px;padding:3px 12px;font-size:0.75rem;border-color:var(--neon-cyan);background:rgba(0,240,255,0.12);color:#fff;font-weight:700" data-action="clean-system" data-mode="quick" title="1-Click dọn dẹp file tạm, giải phóng WAL và nén CSDL SQLite">🧹 Dọn Rác &amp; Temp</button>
            <div class="small muted desktop-only" id="hud-clock" style="font-family:var(--font-mono);font-size:0.75rem;color:var(--neon-cyan)">--:--:--</div>
          </div>
        </div>

        <header class="topbar">
          <span class="breadcrumb">Mail Neon / <strong id="crumb">Sinh Dot Trick & Biến thể</strong></span>
          <span class="small"><span class="pulse-radar" style="margin-right:6px"></span>Máy chủ tại ${esc(location.host)}</span>
        </header>
        <main class="content" id="content"></main>
      </div>

      <div class="bottom-hud-ticker">
        <div class="ticker-live"><span class="status-dot-pulse"></span> LIVE MONITOR</div>
        <div class="ticker-msg" id="ticker-msg">⚡ [${new Date().toLocaleTimeString()}] ${esc(state.lastActionMessage)}</div>
        <div style="display:flex;align-items:center;gap:8px">
          <button class="btn small" style="min-height:22px;padding:1px 8px;font-size:0.68rem;background:rgba(255,0,85,0.15);border-color:rgba(255,0,85,0.4);color:var(--neon-danger);font-weight:700;cursor:pointer" data-action="clean-system" data-mode="quick" title="Dọn dẹp rác &amp; Temp">🧹 Dọn Temp</button>
          <div class="small muted desktop-only">Mail Neon Workspace</div>
        </div>
      </div>
    </div>`;

  // Start digital clock & telemetry timer
  if (!state.telemetryTimer) {
    refreshTelemetry();
    let tickCount = 0;
    state.telemetryTimer = setInterval(() => {
      const clockEl = document.querySelector('#hud-clock');
      if (clockEl) clockEl.textContent = new Date().toLocaleTimeString('vi-VN');
      tickCount++;
      if (tickCount % 4 === 0) refreshTelemetry();
    }, 1000);
  }
}

function head(kicker, title, description, actions='') {
  return `<div class="page-head"><div><div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}</h1><p class="muted">${esc(description)}</p></div><div class="toolbar">${actions}</div></div>`;
}

function setPage(page) {
  if (state.plusJob && page !== 'generator') state.plusJob.cancelled = true;
  state.page = page;
  state.selectedMessage = null;
  render();
}

async function render() {
  if (!state.user) return renderAuth();
  if (!app.querySelector('.app-shell')) shell();
  for (const button of app.querySelectorAll('[data-page]')) button.classList.toggle('active', button.dataset.page === state.page);
  const names = {
    generator: 'Sinh Dot Trick & Biến thể',
    inbox: 'Hộp thư & Bắt OTP',
    aliases: 'Danh sách Mail đã tạo',
    connections: 'Kết nối & Inbound',
    loadtest: 'Load Test & Stress Lab',
    settings: 'Cài đặt'
  };
  const crumb = app.querySelector('#crumb');
  if (crumb) crumb.textContent = names[state.page] || 'Tổng quan';
  const content = app.querySelector('#content');
  content.innerHTML = '<div class="muted">Đang tải dữ liệu…</div>';

  try {
    if (state.page === 'generator') return await renderGenerator(content);
    if (state.page === 'inbox') return await renderInbox(content);
    if (state.page === 'aliases') return await renderAliases(content);
    if (state.page === 'connections') return await renderConnections(content);
    if (state.page === 'loadtest') return await renderLoadTest(content);
    if (state.page === 'settings') return await renderSettings(content);
  } catch (error) {
    content.innerHTML = `<div class="notice error">${esc(error.message)} <button class="btn small" data-action="refresh">Thử lại</button></div>`;
  }
}

// ----------------- VIEW 1: POWER GENERATOR (DOT TRICK & PLUS) -----------------
async function renderGenerator(root) {
  state.mailboxes = await api('/mailboxes');
  root.innerHTML = head('Bộ công cụ sinh Mail', '⚡ Máy sinh Gmail Dot Trick & Biến thể', 'Sinh biến thể của một Gmail thật. Để thư và OTP xuất hiện, hãy kết nối đúng hộp thư Gmail qua OAuth.',
    `<button class="btn primary small" data-page="inbox">✉ Xem Hộp thư & OTP →</button>`
  ) + `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px;flex-wrap:wrap">
      <div class="unified-tab-bar" aria-label="Chọn công cụ sinh mail">
        <button class="unified-tab ${state.generatorTab==='dots'?'active':''}" data-action="switch-gen-tab" data-tab="dots">⚡ Gmail Dot Trick (Dấu chấm)</button>
        <button class="unified-tab ${state.generatorTab==='plus'?'active':''}" data-action="switch-gen-tab" data-tab="plus">➕ Gmail Thẻ Plus (+ Tag)</button>
        <button class="unified-tab ${state.generatorTab==='temp'?'active':''}" data-action="switch-gen-tab" data-tab="temp">⏱ Mail Tạm 1-Chạm (Disposable)</button>
      </div>
      <div class="desktop-only" style="display:flex;align-items:center;gap:8px">
        <label for="gen-mode-select" class="small muted" style="margin:0;white-space:nowrap">Chọn nhanh:</label>
        <select id="gen-mode-select" class="field" style="padding:6px 12px;font-size:0.82rem;min-height:36px">
          <option value="dots" ${state.generatorTab==='dots'?'selected':''}>⚡ Gmail Dot Trick (Dấu chấm)</option>
          <option value="plus" ${state.generatorTab==='plus'?'selected':''}>➕ Gmail Thẻ Plus (+ Tag)</option>
          <option value="temp" ${state.generatorTab==='temp'?'selected':''}>⏱ Mail Tạm 1-Chạm</option>
        </select>
      </div>
    </div>

    ${state.generatorTab === 'dots' ? renderDotsPanel() : state.generatorTab === 'plus' ? renderPlusPanel() : renderTempPanel()}
  `;
}

function renderDotsPanel() {
  const info = state.generatedDotsInfo;
  return `
    <div class="grid two-col">
      <section class="panel">
        ${statusStrip('BỘ XỬ LÝ SINH DOT TRICK', 'THUẬT TOÁN: 2^(N-1) BITWISE SHIFTER', 'TỐI ĐA 2000 KẾT QUẢ/LẦN')}
        <div class="panel-head">
          <h2>Cấu hình sinh Gmail Dot Trick</h2>
          <span class="badge">Thuật toán $2^{n-1}$</span>
        </div>
        <div class="panel-body">
          <form data-form="generate-dots">
            <div>
              <label for="dot-email">Địa chỉ Gmail gốc</label>
               <input id="dot-email" name="email" type="email" required placeholder="ví dụ: nguyenvana@gmail.com" value="${esc(state.lastDotEmail || state.mailboxes.find(x=>x.provider==='google' && x.capabilities.sync)?.address || '')}">
              <p class="help">Các dấu chấm tạo địa chỉ phụ của Gmail gốc. Muốn nhận OTP trong ứng dụng, hãy kết nối Gmail gốc của bạn.</p>
            </div>

            <div class="section-gap">
              <label for="dot-count">Số lượng muốn sinh (Gom gọn dễ chọn)</label>
              <select id="dot-count" name="count" class="field" style="width:100%">
                <option value="50" ${state.lastDotCount==='50'?'selected':''}>50 mail biến thể</option>
                <option value="100" ${state.lastDotCount==='100'?'selected':''}>100 mail biến thể</option>
                <option value="250" ${state.lastDotCount==='250'?'selected':''}>250 mail biến thể</option>
                <option value="500" ${state.lastDotCount==='500'?'selected':''}>500 mail biến thể</option>
                <option value="all" ${state.lastDotCount==='all'?'selected':''}>Toàn bộ kết hợp lý thuyết (tối đa 2.000)</option>
              </select>
            </div>

            <div class="section-gap">
              <label for="dot-mode">Cách sinh biến thể</label>
              <select id="dot-mode" name="mode">
                <option value="combined" ${state.dotMode==='combined'?'selected':''}>Tất cả</option>
                <option value="categorized" ${state.dotMode==='categorized'?'selected':''}>Phân loại</option>
              </select>
              <p class="help">Tất cả gộp 5 cách sinh, chọn tổ hợp ngẫu nhiên không trùng và ghi nhãn cho từng địa chỉ.</p>
            </div>

            <div class="section-gap" id="dot-pattern-wrap" ${state.dotMode==='categorized'?'':'hidden'}>
              <label for="dot-pattern">Chọn mẫu gợi ý</label>
              <select id="dot-pattern" name="pattern" ${state.dotMode==='categorized'?'':'disabled'}>
                <option value="binary" ${state.dotPattern==='binary'?'selected':''}>Tất cả tổ hợp theo thứ tự nhị phân</option>
                <option value="random" ${state.dotPattern==='random'?'selected':''}>Xáo trộn ngẫu nhiên, không trùng</option>
                <option value="one_dot" ${state.dotPattern==='one_dot'?'selected':''}>1 dấu chấm — a.bc, ab.c</option>
                <option value="two_dots" ${state.dotPattern==='two_dots'?'selected':''}>2 dấu chấm — a.b.c, a.bc.d</option>
                <option value="alternating" ${state.dotPattern==='alternating'?'selected':''}>Xen kẽ đều — a.b.c.d</option>
              </select>
            </div>

            <div class="section-gap" style="display:flex;align-items:center;gap:10px">
              <input type="checkbox" id="use-googlemail" name="useGooglemail" style="width:18px;height:18px;margin:0" ${state.dotUseGooglemail?'checked':''}>
              <label for="use-googlemail" style="margin:0;cursor:pointer">Dùng đuôi <strong>@googlemail.com</strong> thay cho @gmail.com</label>
            </div>

            <div class="form-actions" style="margin-top:24px">
              <button class="btn primary" type="submit">⚡ Bắt đầu sinh Dot Trick</button>
            </div>
          </form>
        </div>
      </section>

      <section class="panel">
        ${statusStrip('KẾT QUẢ BIẾN THỂ', `${state.generatedDots.length} ĐỊA CHỈ HỢP LỆ`, 'RFC 5322')}
        <div class="panel-head">
          <h2>Kết quả sinh (${state.generatedDots.length})</h2>
          ${info ? `<span class="count-badge">${info.spaces} vị trí chấm · Tối đa ${info.totalVariants} biến thể có chấm</span>` : ''}
        </div>
        <div class="panel-body" style="padding-bottom:12px">
          ${state.generatedDots.length ? `
            <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
              <button class="btn small" data-action="copy-all-dots">📋 Sao chép địa chỉ (${state.generatedDots.length})</button>
              <button class="btn small" data-action="download-dots-txt">💾 Tải TXT có phân loại</button>
               <button class="btn small primary" data-action="save-dots-to-backend" ${matchingGmailMailbox()?'':'disabled'}>⚡ Lưu vào Gmail đã kết nối</button>
              <button class="btn small danger" data-action="clear-generated-view" title="Xóa danh sách biến thể đang hiển thị">🧹 Xóa danh sách</button>
            </div>
             ${matchingGmailMailbox()?'':'<p class="help">Chưa kết nối Gmail gốc: danh sách này chưa thể nhận OTP trong ứng dụng. <button class="btn small" data-page="connections">Mở Kết nối & Inbound</button></p>'}
             <p class="help">${info?.mode==='combined'?'Đã gộp 5 cách: tổ hợp, ngẫu nhiên, 1 chấm, 2 chấm và xen kẽ. Mỗi địa chỉ chỉ hiện một lần.':`Mẫu đang chọn: ${esc(dotCategoryName(info?.pattern))}.`}</p>
             <div class="results-box">
              ${state.generatedDots.map((addr, idx) => `
                <div class="gen-row">
                  <div class="gen-result"><span class="gen-addr"><span style="color:var(--text-dim);margin-right:8px;font-size:0.75rem">#${idx+1}</span>${esc(addr)}</span><span class="variant-tags">${(info?.details?.[idx]?.categories||[]).map(category=>`<span class="variant-tag">${esc(dotCategoryName(category))}</span>`).join('')}</span></div>
                  <button class="btn small" style="min-height:26px;padding:2px 8px;font-size:0.75rem" data-action="copy" data-value="${esc(addr)}">Copy</button>
                </div>
              `).join('')}
            </div>
          ` : `
            <div class="empty">
              <div class="empty-icon">⚡</div>
              <strong>${info?'Không có vị trí chèn dấu chấm':'Chưa sinh biến thể nào'}</strong>
              <span>${info?'Tên Gmail cần ít nhất 2 ký tự để tạo biến thể Dot Trick.':'Nhập email của bạn bên trái và nhấn nút "⚡ Bắt đầu sinh Dot Trick".'}</span>
            </div>
          `}
        </div>
      </section>
    </div>
  `;
}

function renderPlusPanel() {
  const pageSize = 200;
  const total = state.generatedPlus.length;
  const start = state.plusPage * pageSize;
  const visible = state.generatedPlus.slice(start, start + pageSize);
  return `
    <div class="grid two-col">
      <section class="panel">
        ${statusStrip('BỘ SINH THẺ PLUS: SẴN SÀNG', 'PHÂN LOẠI DANH MỤC THÔNG MINH', 'INDEX CHUẨN')}
        <div class="panel-head">
          <h2>Cấu hình sinh Gmail Thẻ Plus (+)</h2>
          <span class="badge">RFC Sub-addressing</span>
        </div>
        <div class="panel-body">
          <form data-form="generate-plus">
            <div>
              <label for="plus-email">Địa chỉ Gmail gốc</label>
               <input id="plus-email" name="email" type="email" required placeholder="ví dụ: nguyenvana@gmail.com" value="${esc(state.lastDotEmail || state.mailboxes.find(x=>x.provider==='google' && x.capabilities.sync)?.address || '')}">
              <p class="help">Thẻ Plus là địa chỉ phụ của Gmail gốc. Cần kết nối Gmail gốc để nhận OTP trong ứng dụng.</p>
            </div>

            <div class="section-gap">
              <label for="plus-preset">Gói từ khóa sẵn có (Chọn danh mục gom gọn)</label>
              <select id="plus-preset" name="preset" class="field" style="width:100%">
                <option value="social" ${state.lastPlusPreset==='social'?'selected':''}>🌐 Mạng xã hội (Facebook, TikTok, Instagram, Twitter, Telegram, Discord...)</option>
                <option value="services" ${state.lastPlusPreset==='services'?'selected':''}>🤖 AI & Dịch vụ công nghệ (OpenAI, Claude, GitHub, AWS, Stripe...)</option>
                <option value="numbers" ${state.lastPlusPreset==='numbers'?'selected':''}>🔢 Số thứ tự liên tiếp (+001, +002, +003...)</option>
                <option value="random_hash" ${state.lastPlusPreset==='random_hash'?'selected':''}>🎲 Mã băm ngẫu nhiên (+a9f3b, +e72d1...)</option>
                <option value="date" ${state.lastPlusPreset==='date'?'selected':''}>📅 Theo ngày hiện tại (+20260927_1, +20260927_2...)</option>
              </select>
            </div>

            <div class="section-gap">
              <label for="plus-count">Số lượng muốn sinh</label>
              <input id="plus-count" name="count" type="text" inputmode="numeric" pattern="[1-9][0-9]*" required value="${esc(state.plusCount)}" placeholder="Ví dụ: 999">
              <p class="help">Nhập số nguyên dương bất kỳ. Ứng dụng tạo theo lô 2.000 để có thể dừng; số lượng rất lớn phụ thuộc bộ nhớ máy và giới hạn ký tự Gmail.</p>
            </div>

            <div class="form-actions" style="margin-top:24px">
              <button class="btn primary" type="submit">➕ Bắt đầu sinh Thẻ Plus</button>
              <button class="btn danger" type="button" data-action="stop-plus" id="stop-plus" hidden>Dừng tạo</button>
            </div>
            <p class="help" id="plus-progress" role="status"></p>
          </form>
        </div>
      </section>

      <section class="panel">
        ${statusStrip('KẾT QUẢ THẺ PLUS', `${state.generatedPlus.length} BIẾN THỂ ĐÍNH KÈM`, 'CHỈ MỤC TỰ ĐỘNG')}
        <div class="panel-head">
          <h2>Kết quả thẻ Plus (${state.generatedPlus.length})</h2>
        </div>
        <div class="panel-body">
          ${state.generatedPlus.length ? `
            <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
              <button class="btn small" data-action="copy-all-plus">📋 Sao chép toàn bộ (${state.generatedPlus.length})</button>
              <button class="btn small" data-action="download-plus-txt">💾 Tải file .TXT</button>
               <button class="btn small primary" data-action="save-plus-to-backend" ${matchingGmailMailbox()?'':'disabled'}>⚡ Lưu vào Gmail đã kết nối</button>
              <button class="btn small danger" data-action="clear-generated-view" title="Xóa danh sách biến thể đang hiển thị">🧹 Xóa danh sách</button>
            </div>
             ${matchingGmailMailbox()?'':'<p class="help">Cần kết nối đúng Gmail qua OAuth trước khi lưu. Thẻ Plus vẫn có thể sao chép hoặc xuất TXT.</p>'}
             <div class="results-box">
              <div class="result-pager"><span>Đang xem ${start + 1}–${start + visible.length} / ${total}</span><button class="btn small" data-action="plus-prev" ${state.plusPage===0?'disabled':''}>← Trước</button><button class="btn small" data-action="plus-next" ${start + visible.length>=total?'disabled':''}>Sau →</button></div>
              ${visible.map((addr, idx) => `
                <div class="gen-row">
                  <span class="gen-addr"><span style="color:var(--text-dim);margin-right:8px;font-size:0.75rem">#${start+idx+1}</span>${esc(addr)}</span>
                  <button class="btn small" style="min-height:26px;padding:2px 8px;font-size:0.75rem" data-action="copy" data-value="${esc(addr)}">Copy</button>
                </div>
              `).join('')}
            </div>
          ` : `
            <div class="empty">
              <div class="empty-icon">➕</div>
              <strong>Chưa sinh thẻ Plus nào</strong>
              <span>Chọn gói từ khóa bên trái và nhấn nút "➕ Bắt đầu sinh Thẻ Plus".</span>
            </div>
          `}
        </div>
      </section>
    </div>
  `;
}

function renderTempPanel() {
  const domainBox=state.mailboxes.find(x=>x.provider==='domain' && x.capabilities?.inbound && x.status==='connected');
  return `
    <section class="panel" style="max-width:800px;margin:0 auto">
      ${statusStrip(domainBox?'MAIL TẠM: DOMAIN ĐÃ KHAI BÁO':'MAIL TẠM: CẦN CẤU HÌNH DOMAIN', 'TỰ ĐỘNG HẾT HẠN', 'INBOUND WEBHOOK')}
      <div class="panel-head">
        <h2>Tạo Mail tạm 1-Chạm (Disposable Mail)</h2>
        <span class="badge warn">Hết hạn tự động</span>
      </div>
      <div class="panel-body">
        <p class="muted">${domainBox?`Tạo địa chỉ trên ${esc(state.config.ownedDomain)}. Thư thật chỉ đến sau khi MX và webhook nhận mail được cấu hình, kiểm tra thành công.`:'Để tạo địa chỉ mail tạm có thể nhận thư thật, hãy cấu hình domain riêng, MX và webhook trong README.'}</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(160px,1fr));gap:12px;margin:20px 0">
          <button class="btn primary" style="padding:16px 12px;font-weight:700" data-action="quick-temp" data-ttl="15m" ${domainBox?'':'disabled'}>⚡ Tạm 15 phút</button>
          <button class="btn" style="padding:16px 12px;font-weight:700" data-action="quick-temp" data-ttl="1h" ${domainBox?'':'disabled'}>⏱ Tạm 1 giờ</button>
          <button class="btn" style="padding:16px 12px;font-weight:700" data-action="quick-temp" data-ttl="24h" ${domainBox?'':'disabled'}>📅 Tạm 24 giờ</button>
          <button class="btn" style="padding:16px 12px;font-weight:700" data-action="quick-temp" data-ttl="7d" ${domainBox?'':'disabled'}>🗓 Tạm 7 ngày</button>
        </div>
        <p class="small muted">Mẹo: Sau khi tạo, bạn có thể chuyển sang tab <strong>"✉ Hộp thư & OTP"</strong> để xem trực tiếp thư xác minh gửi đến địa chỉ tạm này.</p>
      </div>
    </section>
  `;
}

// ----------------- VIEW 2: INBOX & LIVE OTP CATCHER -----------------
async function renderInbox(root) {
  const unreadParam = state.unreadOnly ? '&unread=1' : '';
  const [mailboxes, result] = await Promise.all([
    api('/mailboxes'),
    api(`/messages?limit=50&q=${encodeURIComponent(state.search)}${unreadParam}`)
  ]);

  root.innerHTML = head('Bộ bắt OTP & Hộp thư', '✉ Hộp thư & Bắt OTP Trực tiếp', 'Tự động nhận diện thư gửi đến mọi biến thể Dot Trick, Plus và Mail tạm. Tự động bóc tách mã OTP ra khối phát sáng nổi bật.',
    `<span class="small muted" style="display:flex;align-items:center;gap:6px"><span class="pulse-radar"></span>Đang tự động cập nhật (3s)</span>
     <button class="btn small" data-action="mark-all-read" title="Đánh dấu tất cả thư là đã đọc">✓ Đọc tất cả</button>
     <button class="btn small" data-action="export-messages-json" title="Xuất toàn bộ thư và mã OTP bóc tách ra file JSON">💾 Xuất OTP & Thư</button>
     <button class="btn small" data-action="refresh">↻ Làm mới ngay</button>
     <button class="btn small danger" data-action="clean-inbox-all" title="Xóa toàn bộ thư trong hộp thư">🧹 Dọn sạch thư rác</button>`
  ) + `
    <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap">
      <button class="chip ${!state.unreadOnly?'active':''}" data-action="toggle-unread-filter" data-val="0">Tất cả thư</button>
      <button class="chip ${state.unreadOnly?'active':''}" data-action="toggle-unread-filter" data-val="1">Chỉ thư chưa đọc</button>
    </div>
    <form class="searchrow" data-form="search">
      <label class="small" for="search-mail">Tìm thư / Lọc theo địa chỉ</label>
      <input id="search-mail" name="q" type="search" placeholder="Nhập tiêu đề, người gửi, hoặc địa chỉ biến thể cụ thể..." value="${esc(state.search)}">
      <button class="btn" type="submit">Tìm kiếm</button>
    </form>
    <section class="panel inbox-layout">
      <div class="message-list">
        ${statusStrip('GIÁM SÁT HỘP THƯ', `${result.items.length} THƯ TRONG HỆ THỐNG`, 'SMTP: 2525')}
        <div class="panel-head">
          <h2>${result.items.length} thư ${state.unreadOnly ? '(chưa đọc)' : ''}</h2>
          <span class="small muted">Trang 50 thư</span>
        </div>
        <div class="list">
          ${result.items.length ? result.items.map(messageRow).join('') : empty('Hộp thư đang trống', state.unreadOnly ? 'Không có thư nào chưa đọc.' : 'Gửi email thử nghiệm vào địa chỉ biến thể hoặc qua cổng SMTP 2525 để xem mã OTP xuất hiện tại đây.')}
        </div>
      </div>
      <div class="message-detail" id="message-detail">
        ${statusStrip('CHI TIẾT NỘI DUNG', 'MÃ HÓA AES-256-GCM', 'OTP EXTRACTOR')}
        ${empty('Chọn một thư để xem', 'Nội dung thư và mã OTP phát sáng sẽ hiển thị tại khung này.')}
      </div>
    </section>`;

  if (state.selectedMessage) await showMessage(state.selectedMessage);

  state.inboxSignature = result.items.map(x => `${x.id}:${x.is_read}`).join(',');

  if (!state.autoRefreshInterval) {
    state.autoRefreshInterval = setInterval(async () => {
      if (state.page === 'inbox' && !state.selectedMessage) {
        try {
          const unreadParam = state.unreadOnly ? '&unread=1' : '';
          const fresh = await api(`/messages?limit=50&q=${encodeURIComponent(state.search)}${unreadParam}`);
          const currentSig = fresh.items.map(x => `${x.id}:${x.is_read}`).join(',');
          if (state.inboxSignature !== currentSig) {
            const isNew = fresh.items.length > (state.inboxSignature ? state.inboxSignature.split(',').filter(Boolean).length : 0);
            state.inboxSignature = currentSig;
            const listEl = app.querySelector('.message-list .list');
            if (listEl) {
              listEl.innerHTML = fresh.items.length ? fresh.items.map(messageRow).join('') : empty('Hộp thư đang trống', state.unreadOnly ? 'Không có thư nào chưa đọc.' : 'Chưa có thư mới.');
              logTicker(`Đồng bộ hộp thư: ${fresh.items.length} thư (${isNew ? '⚡ Phát hiện thư mới!' : 'Đã cập nhật'})`);
              if (isNew) audioCtx.play('laser');
              refreshTelemetry();
            }
          }
        } catch {}
      }
    }, 3000);
  }
}

function messageRow(m) {
  return `
    <button class="list-item ${m.is_read ? '' : 'unread'} ${state.selectedMessage === m.id ? 'selected' : ''}" data-action="open-message" data-id="${esc(m.id)}">
      <span class="avatar">${esc((m.sender || '?')[0])}</span>
      <span class="list-main">
        <strong>${esc(m.subject || '(Không có tiêu đề)')}</strong>
        <span>${esc(m.sender)} → <strong style="color:var(--neon-cyan)">${esc(m.alias_address || m.mailbox_address)}</strong></span>
      </span>
      <span class="list-meta">${esc(fmt(m.received_at))}</span>
    </button>`;
}

async function showMessage(id) {
  const detail = app.querySelector('#message-detail');
  if (!detail) return;
  detail.innerHTML = '<p class="muted">Đang mở nội dung thư…</p>';
  const m = await api(`/messages/${encodeURIComponent(id)}`);
  if (m.otp) audioCtx.play('laser');
  const otp = m.otp ? `
    <div class="otp-box">
      <div>
        <div class="small" style="color:var(--neon-cyan);font-weight:700;text-transform:uppercase;letter-spacing:0.08em">⚡ MÃ OTP XÁC MINH PHÁT HIỆN TỰ ĐỘNG</div>
        <div class="otp-code">${esc(m.otp.code)}</div>
        <div class="small muted">Hết hiệu lực dự kiến: ${esc(fmt(m.otp.expiresAt))}</div>
      </div>
      <button class="btn primary" style="font-size:0.95rem;padding:12px 20px" data-action="copy" data-value="${esc(m.otp.code)}">📋 Sao chép mã OTP</button>
    </div>` : '';

  detail.innerHTML = `
    ${statusStrip('TRẠNG THÁI: ĐÃ GIẢI MÃ', `NGƯỜI GỬI: ${m.sender}`, 'VERIFIED')}
    <div style="padding:16px">
      <div class="eyebrow">${esc(providerName(m.mailbox_provider))} · ${esc(fmt(m.received_at))}</div>
      <h2>${esc(m.subject || '(Không có tiêu đề)')}</h2>
      <div class="small message-meta">
        <strong>Người gửi:</strong> ${esc(m.sender)}<br>
        <strong>Gửi đến:</strong> ${esc(m.recipients.join(', '))}<br>
        <strong>Biến thể đích:</strong> <span style="color:var(--neon-cyan);font-weight:700">${esc(m.alias_address || m.mailbox_address)}</span>
      </div>
      ${otp}
      <div class="message-body" id="mail-body"></div>
      <div class="form-actions" style="margin-top:16px">
        <button class="btn danger small" data-action="delete-message" data-id="${esc(m.id)}">Xóa thư này</button>
      </div>
    </div>`;

  detail.querySelector('#mail-body').textContent = m.text || '(Thư không có nội dung văn bản thuần)';
  if (!m.is_read) await api(`/messages/${encodeURIComponent(id)}`, {method:'PATCH'}).catch(() => {});
}

// ----------------- VIEW 3: MONITORED ALIASES (DANH SÁCH MAIL ĐÃ TẠO) -----------------
async function renderAliases(root) {
  const aliases = await api(`/aliases?limit=500&q=${encodeURIComponent(state.aliasSearch)}`);

  root.innerHTML = head('Quản lý địa chỉ', '◈ Danh sách Mail đã tạo & Theo dõi', 'Quản lý toàn bộ các biến thể Dot Trick, Plus và Mail tạm đã lưu vào cơ sở dữ liệu backend.',
    `<button class="btn small primary" data-action="export-aliases-txt">💾 Xuất toàn bộ ra .TXT</button>
     <button class="btn small" data-page="generator">+ Sinh thêm biến thể</button>
     <button class="btn small warn" data-action="clean-expired-aliases" title="Xóa các mail tạm đã quá hạn">🧹 Xóa Mail tạm hết hạn</button>
     <button class="btn small danger" data-action="clean-all-aliases" title="Xóa toàn bộ biến thể trong CSDL">🧹 Xóa sạch biến thể</button>`
  ) + `
    <section class="panel">
      ${statusStrip('CƠ SỞ DỮ LIỆU SQLITE WAL', `${aliases.items.length} ĐỊA CHỈ ĐANG HIỂN THỊ`, 'DỮ LIỆU THỰC')}
      <div class="panel-head">
        <h2>Danh sách địa chỉ (${aliases.items.length})</h2>
        <span class="badge neutral">${aliases.items.length} địa chỉ đang theo dõi</span>
      </div>
      <div class="panel-body">
        <form class="searchrow" data-form="alias-search">
          <label for="alias-search">Tìm địa chỉ</label>
          <input id="alias-search" name="q" type="search" placeholder="Tìm theo địa chỉ, mục đích, nguồn..." value="${esc(state.aliasSearch)}">
          <button class="btn" type="submit">Tìm</button>
        </form>
      </div>
      <div class="list">
        ${aliases.items.length ? aliases.items.map(a => `
          <div class="alias-row">
            <div>
              <div class="alias-address">${esc(a.address)}</div>
              <div class="meta">
                <span class="badge ${a.kind==='dot'?'primary':a.kind==='plus'?'warn':'neutral'}">${a.kind.toUpperCase()}</span>
                ${esc(a.purpose || 'Sinh tự động')} · Tạo: ${esc(fmt(a.created_at))}${a.expires_at ? ` · Hết hạn: ${esc(fmt(a.expires_at))}` : ''}
              </div>
            </div>
            <div class="alias-actions">
              <button class="btn small" data-action="copy" data-value="${esc(a.address)}">Sao chép</button>
              <button class="btn small danger" data-action="delete-alias" data-id="${esc(a.id)}">Xóa</button>
            </div>
          </div>`).join('') : empty('Chưa có địa chỉ nào trong cơ sở dữ liệu', 'Kết nối Gmail thật để lưu biến thể, hoặc cấu hình domain riêng để tạo mail tạm.')}
      </div>
    </section>`;
}

// ----------------- VIEW 4: CONNECTIONS & INBOUND -----------------
async function renderConnections(root) {
  const boxes = await api('/mailboxes');
  const providers=state.config?.providers || {};

  root.innerHTML = head('Cổng nhận thư', '⌁ Kết nối Gmail, Hotmail & Mail tạm', 'Kết nối hộp thư bằng OAuth hoặc IMAP TLS. Mail tạm cần domain và cổng nhận thư đã cấu hình.',
    `<button class="btn" data-action="refresh">↻ Làm mới</button>`
  ) + `
    <div class="grid two-col">
      <div class="grid">
        <section class="panel" style="border-left:4px solid var(--neon-cyan)">
          ${statusStrip('KẾT NỐI HỘP THƯ THẬT', 'OAUTH CHỈ ĐỌC THƯ', 'GMAIL / MICROSOFT GRAPH')}
          <div class="panel-head"><h2>Gmail và Outlook / Hotmail</h2></div>
          <div class="panel-body">
            <p class="small muted">Đăng nhập tại Google hoặc Microsoft và cấp quyền đọc Inbox. Nút chỉ bật khi Client ID và Secret tương ứng đã có trong .env.</p>
            <div class="form-actions">
              <button class="btn primary" data-action="oauth-google" ${providers.google?'':'disabled'}>Kết nối Gmail</button>
              <button class="btn" data-action="oauth-microsoft" ${providers.microsoft?'':'disabled'}>Kết nối Outlook / Hotmail</button>
            </div>
            ${!providers.google || !providers.microsoft ? '<p class="help">Xem hướng dẫn tạo OAuth client trong README, sau đó khởi động lại ứng dụng.</p>' : ''}
          </div>
        </section>
        <section class="panel" style="border-left:4px solid var(--neon-emerald)">
          ${statusStrip('MÁY CHỦ SMTP NỘI BỘ', `CỔNG ${state.config?.smtpPort || 2525}`, 'KIỂM TRA TRONG NHẬT KÝ')}
          <div class="panel-head"><h2>Cổng SMTP Inbound</h2></div>
          <div class="panel-body">
            <p class="small muted">Máy chủ tích hợp sẵn bộ nhận mail SMTP theo chuẩn RFC 5321. Bạn có thể chuyển tiếp hoặc gửi email trực tiếp từ các script/tool vào cổng này:</p>
            <div style="background:rgba(9,13,22,0.8);padding:12px;border-radius:8px;border:1px solid var(--line);font-family:var(--font-mono);font-size:0.85rem">
              <strong>Địa chỉ máy chủ:</strong> 127.0.0.1<br>
              <strong>Cổng SMTP:</strong> ${esc(state.config?.smtpPort || 2525)} (kiểm thử cục bộ)<br>
              <strong>Phạm vi:</strong> Chỉ dùng với nguồn gửi do bạn kiểm soát
            </div>
          </div>
        </section>

        <section class="panel" style="border-left:4px solid var(--neon-cyan)">
          ${statusStrip('CỔNG WEBHOOK INBOUND', 'END-POINT: /api/v1/inbound', 'HMAC-SHA256')}
          <div class="panel-head"><h2>Webhook Inbound HTTP</h2></div>
          <div class="panel-body">
            <p class="small muted">Hỗ trợ nhận chuyển tiếp webhook từ Cloudflare Email Routing, SendGrid, Postmark:</p>
            <div style="background:rgba(9,13,22,0.8);padding:12px;border-radius:8px;border:1px solid var(--line);font-family:var(--font-mono);font-size:0.85rem">
              <code>POST ${esc(location.origin)}/api/v1/inbound</code>
            </div>
          </div>
        </section>
      </div>

      <section class="panel">
        ${statusStrip('HỘP THƯ LIÊN KẾT', `${boxes.length} TÀI KHOẢN ĐỒNG BỘ`, 'TLS 1.3')}
        <div class="panel-head"><h2>Hộp thư đã kết nối (${boxes.length})</h2></div>
        <div class="list">
          ${boxes.length ? boxes.map(box => `
            <div class="connection">
              <div class="connection-title">
                <span class="provider-icon">${esc(box.provider[0].toUpperCase())}</span>
                <div>
                  <strong>${esc(box.address)}</strong>
                  <div class="small muted">${esc(providerName(box.provider))} · ${box.capabilities.sync?'Có thể đồng bộ':box.provider==='domain'?'Nhận qua webhook/MX':'Chưa kết nối thật'}</div>
                  ${box.last_error?`<div class="small muted">${esc(box.last_error)}</div>`:''}
                </div>
              </div>
              <div class="connection-actions">
                ${box.capabilities.sync ? `<button class="btn small" data-action="sync" data-id="${esc(box.id)}">Đồng bộ</button>` : ''}
                  ${box.provider!=='domain'?`<button class="btn small danger" data-action="disconnect" data-id="${esc(box.id)}">Ngắt</button>`:''}
              </div>
            </div>`).join('') : empty('Chưa kết nối hộp thư', 'Thêm IMAP hoặc dùng SMTP nội bộ.')}
        </div>
        <div class="panel-body" style="border-top:1px solid var(--line)">
          <h3>Thêm hộp thư IMAP (Gmail / Outlook)</h3>
          <form data-form="imap">
            <div class="form-grid">
              <div class="full"><label for="imap-address">Địa chỉ email</label><input id="imap-address" name="address" type="email" placeholder="you@gmail.com hoặc you@outlook.com" required></div>
              <div><label for="imap-host">Máy chủ IMAP</label><input id="imap-host" name="host" placeholder="imap.gmail.com" required></div>
              <div><label for="imap-port">Cổng TLS</label><input id="imap-port" name="port" type="number" value="993" required></div>
              <div><label for="imap-user">Tên đăng nhập</label><input id="imap-user" name="username" required></div>
              <div><label for="imap-password">Mật khẩu ứng dụng (App Password)</label><input id="imap-password" name="password" type="password" required></div>
            </div>
            <div class="form-actions"><button class="btn primary" type="submit">Kiểm tra & Kết nối IMAP</button></div>
          </form>
        </div>
      </section>
    </div>`;
}

// ----------------- VIEW 5: LOAD TEST & STRESS LAB -----------------
async function renderLoadTest(root) {
  const lt = state.loadtest;

  root.innerHTML = head('Đo tải & Hiệu năng cao', '🚀 Load Test & Stress Engine', 'Thử nghiệm giới hạn thông lượng của thuật toán sinh mail, tốc độ nạp dữ liệu SQLite và độ trễ phản hồi của hệ thống.',
    `<button class="btn small" data-action="clear-loadtest-logs">Xóa Logs</button>
     <button class="btn small primary" data-action="export-loadtest-report">↓ Xuất Báo cáo</button>`
  ) + `
    <div class="loadtest-hero">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
        <div>
          <div class="eyebrow" style="color:var(--neon-cyan)">⚡ NATIONAL-GRADE PERFORMANCE ENGINE</div>
          <h2 style="margin:4px 0 8px 0;font-size:1.6rem">Phòng Thử Nghiệm Tải Trọng Cực Đại</h2>
          <p class="muted" style="margin:0;max-width:680px">Đo lường năng lực tính toán nhị phân, thông lượng HTTP Burst đồng thời và tốc độ giao dịch ghi SQLite WAL với độ chính xác nano-giây.</p>
        </div>
        <div style="text-align:right">
          <span class="badge ${lt.running ? 'warn' : 'primary'}" style="font-size:0.85rem;padding:6px 14px">
            ${lt.running ? '⚡ ĐANG CHẠY TEST...' : '● SẴN SÀNG KIỂM TRA'}
          </span>
        </div>
      </div>
    </div>

    <!-- 4 High-Voltage Gauges -->
    <div class="metric-grid">
      <div class="gauge-card cyan">
        <div class="gauge-label">Thông lượng (Throughput)</div>
        <div class="gauge-number" id="gauge-rps">${lt.rps ? lt.rps.toLocaleString() : '---'} <span style="font-size:0.9rem">/s</span></div>
        <div class="small muted">Tốc độ tính toán & xử lý</div>
      </div>
      <div class="gauge-card emerald">
        <div class="gauge-label">Độ trễ trung bình</div>
        <div class="gauge-number" id="gauge-lat">${lt.avgLatency ? lt.avgLatency.toFixed(2) : '---'} <span style="font-size:0.9rem">ms</span></div>
        <div class="small muted">Thời gian phản hồi bình quân</div>
      </div>
      <div class="gauge-card purple">
        <div class="gauge-label">Tỷ lệ thành công</div>
        <div class="gauge-number" id="gauge-success">${lt.successRate}%</div>
        <div class="small muted">Độ tin cậy giao dịch</div>
      </div>
      <div class="gauge-card amber">
        <div class="gauge-label">Tổng số bản ghi/lượt</div>
        <div class="gauge-number" id="gauge-proc">${lt.processed ? lt.processed.toLocaleString() : '---'}</div>
        <div class="small muted">Quy mô gói thử nghiệm</div>
      </div>
    </div>

    <div class="grid two-col" style="margin-top:20px">
      <!-- Control Panel -->
      <section class="panel">
        ${statusStrip('BẢNG ĐIỀU KHIỂN THỬ NGHIỆM', '3 KỊCH BẢN CHUẨN ĐO LƯỜNG', 'CHÍNH XÁC CAO')}
        <div class="panel-head"><h2>Cấu hình kịch bản đo tải</h2></div>
        <div class="panel-body">
          <form data-form="loadtest-run">
            <div>
              <label for="lt-mode">Kịch bản kiểm tra</label>
              <select id="lt-mode" name="mode">
                <option value="generator" ${lt.mode==='generator'?'selected':''}>⚡ Thuật toán sinh Dot Trick nhị phân (BigInt Throughput)</option>
                <option value="http_burst" ${lt.mode==='http_burst'?'selected':''}>🌐 Bắn tải HTTP Concurrent Burst (Yêu cầu đồng thời)</option>
                <option value="sqlite_batch" ${lt.mode==='sqlite_batch'?'selected':''}>🗄 Giao dịch ghi hàng loạt SQLite WAL (Batch Commit)</option>
              </select>
            </div>

            <div class="section-gap">
              <label for="lt-count">Quy mô gói kiểm tra (Số lượng)</label>
              <select id="lt-count" name="count">
                <option value="1000">1,000 yêu cầu / biến thể</option>
                <option value="5000">5,000 yêu cầu / biến thể</option>
                <option value="20000" selected>20,000 yêu cầu / biến thể</option>
                <option value="50000">50,000 yêu cầu / biến thể</option>
                <option value="100000">100,000 yêu cầu / biến thể (Cực đại)</option>
              </select>
            </div>

            <div class="section-gap" id="concurrency-group">
              <label for="lt-concurrency">Mức độ đa luồng đồng thời (Concurrency)</label>
              <select id="lt-concurrency" name="concurrency">
                <option value="10">10 luồng đồng thời</option>
                <option value="25" selected>25 luồng đồng thời</option>
                <option value="50">50 luồng đồng thời</option>
                <option value="100">100 luồng đồng thời</option>
              </select>
            </div>

            <div class="shimmer-progress">
              <div class="shimmer-bar" id="loadtest-progress-bar" style="width:${lt.progress}%"></div>
            </div>

            <div class="form-actions" style="margin-top:20px">
              <button class="btn primary" type="submit" id="btn-run-loadtest" ${lt.running ? 'disabled' : ''} style="width:100%;padding:14px;font-size:1rem;font-weight:700">
                ${lt.running ? '⚡ Đang thực thi kịch bản đo tải...' : '🚀 BẮT ĐẦU KIỂM TRA TẢI TRỌNG (START TEST)'}
              </button>
            </div>
          </form>
        </div>
      </section>

      <!-- Hacker Live Console & Wave Chart -->
      <section class="panel">
        ${statusStrip('NHẬT KÝ THỜI GIAN THỰC', 'ĐỘ PHÂN GIẢI MICROSECOND', 'STREAMING')}
        <div class="panel-head">
          <h2>Nhật ký thực thi (Live Console)</h2>
          <span class="count-badge" id="log-count">${lt.logs.length} logs</span>
        </div>
        <div class="panel-body">
          <div class="console-terminal" id="loadtest-console">
            ${lt.logs.map(line => `<div class="console-line ${line.includes('LỖI') ? 'error' : line.includes('HOÀN TẤT') ? 'success' : line.includes('THÔNG LƯỢNG') ? 'warn' : 'info'}">${esc(line)}</div>`).join('')}
          </div>
        </div>
      </section>
    </div>
  `;
}

// ----------------- VIEW 6: SETTINGS -----------------
async function renderSettings(root) {
  const events = await api('/audit');
  root.innerHTML = head('Quản trị', 'Cài đặt hệ thống', 'Quản lý cấu hình, xuất dữ liệu và xóa dữ liệu.',
    `<button class="btn" data-action="export">↓ Xuất JSON</button>`
  ) + `
    <div class="grid two-col">
      <section class="panel">
        ${statusStrip('BẢO MẬT HỆ THỐNG', 'AES-256-GCM + SCRYPT', 'CSRF SHIELD')}
        <div class="panel-head"><h2>Cài đặt Backend</h2></div>
        <div class="panel-body settings-list">
          <div class="settings-item">
            <strong>Tài khoản đang dùng</strong>
            <div class="small muted">${esc(state.user?.email || 'local@workspace')}</div>
            <form data-form="account-credentials" style="display:grid;gap:10px;margin-top:14px">
              <label for="owner-email">Email quản trị</label><input id="owner-email" name="email" type="email" required value="${esc(state.user?.email || '')}">
              <label for="owner-current">Mật khẩu hiện tại hoặc mã thiết lập</label><input id="owner-current" name="currentPassword" type="password" autocomplete="current-password" placeholder="Mật khẩu hiện tại nếu có">
              <input name="setupToken" type="password" autocomplete="off" aria-label="Mã thiết lập SETUP_TOKEN" placeholder="Hoặc SETUP_TOKEN trong .env">
              <label for="owner-new">Mật khẩu mới</label><input id="owner-new" name="password" type="password" minlength="12" autocomplete="new-password" required>
              <button class="btn primary small" type="submit">Lưu tài khoản quản trị</button>
            </form>
          </div>
          <div class="settings-item">
            <strong>Địa chỉ Backend kết nối</strong>
            <div class="small muted">${esc(location.origin)}</div>
          </div>
          <div class="settings-item" style="border:1px solid rgba(0,240,255,0.3);border-radius:10px;padding:16px;background:rgba(0,240,255,0.03);margin-top:14px">
            <strong style="color:var(--neon-cyan);font-size:0.95rem;display:flex;align-items:center;gap:8px">
              🧹 TRUNG TÂM DỌN DẸP RÁC &amp; TỐI ƯU HỆ THỐNG
            </strong>
            <p class="help" style="margin:8px 0 14px 0">Dọn địa chỉ hết hạn và checkpoint SQLite. Reset dữ liệu cần mật khẩu hoặc mã thiết lập và tạo bản sao lưu trước khi xóa.</p>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button class="btn primary small" style="padding:10px 16px;font-weight:700" data-action="clean-system" data-mode="quick">
                🧹 Dọn Rác &amp; Temp 1-Chạm (Quick Clean)
              </button>
              <button class="btn danger small" style="padding:10px 16px;font-weight:700" data-action="clean-system" data-mode="full">
                🧨 Xóa Sạch Dữ Liệu &amp; Reset Gốc (Full Reset)
              </button>
            </div>
            <label for="reset-auth" style="margin-top:14px">Mật khẩu quản trị hoặc SETUP_TOKEN để reset</label>
            <input id="reset-auth" type="password" autocomplete="off" placeholder="Chỉ cần nhập khi chọn Full Reset">
            <div class="small muted" style="margin-top:12px;line-height:1.5">
              • <strong>Dọn nhanh:</strong> Xóa địa chỉ hết hạn, phiên hết hạn và checkpoint SQLite.<br>
              • <strong>Reset:</strong> Sao lưu CSDL rồi xóa thư và địa chỉ trong ứng dụng. Tài khoản quản trị vẫn còn.
            </div>
          </div>
        </div>
      </section>

      <section class="panel">
        ${statusStrip('NHẬT KÝ HỆ THỐNG', `${events.length} SỰ KIỆN GHI NHẬN`, 'IMMUTABLE AUDIT')}
        <div class="panel-head"><h2>Nhật ký hoạt động</h2></div>
        <div class="list">
          ${events.length ? events.map(x => `
            <div class="alias-row">
              <div>
                <strong>${esc(x.action)}</strong>
                <div class="meta">${esc(fmt(x.created_at))}</div>
              </div>
            </div>`).join('') : empty('Chưa có nhật ký', 'Các thao tác sẽ được ghi lại tại đây.')}
        </div>
      </section>
    </div>`;
}

function renderAuth() {
  const setup = state.config?.setupRequired;
  app.innerHTML = `
    <div class="auth-wrap">
      <section class="auth-art">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">⚡</span>
          <span>Mail Neon<br><span style="font-size:0.75rem;font-weight:600;color:var(--neon-cyan);letter-spacing:0.08em;text-transform:uppercase">Power Workspace</span></span>
        </div>
        <div>
          <div class="eyebrow">Công cụ sinh Dot Trick & Bắt OTP</div>
          <h1>Mọi biến thể thư.<br>Một hộp thư rõ ràng.</h1>
          <p>Tự động tạo hàng ngàn địa chỉ Gmail Dot Trick, Thẻ Plus (+) và bắt OTP thời gian thực với backend lưu trữ cục bộ.</p>
        </div>
        <div class="small muted">Bảo mật mã hóa · SQLite WAL · Không rò rỉ dữ liệu</div>
      </section>
      <section class="auth-panel">
        <div class="auth-card">
          <div class="eyebrow">${setup ? 'Thiết lập lần đầu' : 'Đăng nhập'}</div>
          <h2>${setup ? 'Tạo tài khoản quản trị' : 'Đăng nhập'}</h2>
          <form data-form="${setup ? 'setup' : 'login'}">
            <div>
              <label for="auth-email">Email</label>
              <input id="auth-email" name="email" type="email" required placeholder="admin@domain.com">
            </div>
            <div>
              <label for="auth-password">Mật khẩu</label>
              <input id="auth-password" name="password" type="password" required minlength="12" placeholder="Ít nhất 12 ký tự">
            </div>
            ${setup ? `
              <div>
                <label for="auth-token">Mã thiết lập (SETUP_TOKEN)</label>
                <input id="auth-token" name="setupToken" required placeholder="Lấy từ file .env">
              </div>` : ''}
            <button class="btn primary" type="submit" style="width:100%;margin-top:10px">${setup ? 'Khởi tạo không gian' : 'Đăng nhập'}</button>
          </form>
        </div>
      </section>
    </div>`;
}

// ----------------- CLICK EVENT DELEGATION -----------------
app.addEventListener('click', async event => {
  const navBtn = event.target.closest('[data-page]');
  if (navBtn) {
    event.preventDefault();
    setPage(navBtn.dataset.page);
    return;
  }

  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  el.disabled = true;

  try {
    if (action === 'refresh') {
      await render();
      toast('Đã làm mới dữ liệu');
    }
    else if (action === 'oauth-google' || action === 'oauth-microsoft') {
      const provider=action==='oauth-google'?'google':'microsoft';
      const result=await api(`/oauth/${provider}/start`,{method:'POST'});
      location.assign(result.url);
    }
    else if (action === 'disconnect') {
      if (!confirm('Ngắt hộp thư này và xóa thư, địa chỉ phụ gắn với nó trong ứng dụng?')) return;
      await api(`/mailboxes/${encodeURIComponent(el.dataset.id)}`,{method:'DELETE'});
      toast('Đã ngắt hộp thư khỏi ứng dụng');
      await render();
    }
    else if (action === 'switch-gen-tab') {
      if (state.plusJob && el.dataset.tab !== 'plus') state.plusJob.cancelled = true;
      state.generatorTab = el.dataset.tab;
      await render();
    }
    else if (action === 'stop-plus') {
      if (state.plusJob) state.plusJob.cancelled = true;
      toast('Đang dừng sau lô hiện tại…');
    }
    else if (action === 'plus-prev' || action === 'plus-next') {
      state.plusPage += action === 'plus-next' ? 1 : -1;
      await render();
    }
    else if (action === 'set-count') {
      for (const c of document.querySelectorAll('#count-selector .chip')) c.classList.toggle('active', c === el);
      const input = document.querySelector('#gen-count-input');
      if (input) input.value = el.dataset.val;
    }
    else if (action === 'set-plus-preset') {
      for (const c of el.parentElement.querySelectorAll('.chip')) c.classList.toggle('active', c === el);
      const input = document.querySelector('#plus-preset-input');
      if (input) input.value = el.dataset.val;
    }
    else if (action === 'toggle-sound') {
      const enabled = audioCtx.toggle();
      const soundBtn = document.querySelector('#btn-sound-toggle');
      if (soundBtn) soundBtn.textContent = enabled ? '🔊 SFX' : '🔇 MUTE';
      toast(enabled ? 'Đã bật âm thanh Cyberpunk 🔊' : 'Đã tắt âm thanh 🔇');
      if (enabled) audioCtx.play('success');
    }
    else if (action === 'copy') {
      await navigator.clipboard.writeText(el.dataset.value || '');
      audioCtx.play('click');
      toast('Đã sao chép: ' + (el.dataset.value || ''));
      logTicker(`Đã sao chép vào bộ nhớ đệm: ${el.dataset.value}`);
    }
    else if (action === 'copy-all-dots') {
      const text = state.generatedDots.join('\n');
      await navigator.clipboard.writeText(text);
      audioCtx.play('success');
      toast(`Đã sao chép ${state.generatedDots.length} địa chỉ Gmail Dot Trick!`);
      logTicker(`Sao chép toàn bộ ${state.generatedDots.length} biến thể Dot Trick`);
    }
    else if (action === 'copy-all-plus') {
      const text = state.generatedPlus.join('\n');
      await navigator.clipboard.writeText(text);
      audioCtx.play('success');
      toast(`Đã sao chép ${state.generatedPlus.length} địa chỉ Thẻ Plus!`);
      logTicker(`Sao chép toàn bộ ${state.generatedPlus.length} thẻ Plus`);
    }
    else if (action === 'download-dots-txt') {
      const lines = state.generatedDots.map((address,index)=>`${address}\t${(state.generatedDotsInfo?.details?.[index]?.categories||[]).map(dotCategoryName).join(', ')}`);
      const blob = new Blob([lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
      downloadBlob(blob, `gmail-dot-variants-${Date.now()}.txt`);
      toast('Đã tải xuống file .TXT');
    }
    else if (action === 'download-plus-txt') {
      const blob = new Blob([state.generatedPlus.join('\r\n')], { type: 'text/plain;charset=utf-8' });
      downloadBlob(blob, `gmail-plus-variants-${Date.now()}.txt`);
      toast('Đã tải xuống file .TXT');
    }
    else if (action === 'export-aliases-txt') {
      const aliases = await api('/aliases?limit=2000');
      const text = aliases.items.map(x => x.address).join('\r\n');
      downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `monitored-aliases-${Date.now()}.txt`);
      toast('Đã tải xuống toàn bộ danh sách địa chỉ .TXT');
    }
    else if (action === 'save-dots-to-backend') {
      if (!state.generatedDots.length) return;
      const mailbox=matchingGmailMailbox();
      if (!mailbox) throw new Error('Hãy kết nối đúng Gmail qua OAuth trước khi lưu');
      const res = await api('/generator/save-batch', {
        method: 'POST',
        body: { mailboxId:mailbox.id, addresses: state.generatedDots, categories: state.generatedDotsInfo?.details?.map(item=>item.categories), purpose: 'Gmail Dot Trick', source: state.lastDotEmail }
      });
      toast(`Đã lưu ${res.inserted} biến thể của ${mailbox.address}`);
      logTicker(`Đã nạp ${res.inserted} địa chỉ Dot Trick vào CSDL backend`);
    }
    else if (action === 'save-plus-to-backend') {
      if (!state.generatedPlus.length) return;
      const mailbox=matchingGmailMailbox();
      if (!mailbox) throw new Error('Hãy kết nối đúng Gmail qua OAuth trước khi lưu');
      let inserted = 0;
      for (let i = 0; i < state.generatedPlus.length; i += 2000) {
        const res = await api('/generator/save-batch', {
          method: 'POST',
          body: { mailboxId:mailbox.id, addresses: state.generatedPlus.slice(i,i+2000), purpose: 'Gmail Thẻ Plus', source: state.lastDotEmail }
        });
        inserted += res.inserted;
      }
      toast(`Đã lưu ${inserted} thẻ Plus của ${mailbox.address}`);
      logTicker(`Đã nạp ${inserted} thẻ Plus vào CSDL backend`);
    }
    else if (action === 'quick-temp') {
      const ttl = el.dataset.ttl;
      const ms = ttl === '15m' ? 15 * 60_000 : ttl === '1h' ? 60 * 60_000 : ttl === '24h' ? 24 * 3600_000 : 7 * 24 * 3600_000;
      const expiresAt = new Date(Date.now() + ms).toISOString();
      const boxes = await api('/mailboxes');
      const domainBox = boxes.find(x => x.provider === 'domain' && x.capabilities?.inbound && x.status==='connected');
      if (!domainBox) throw new Error('Cần cấu hình domain mail tạm trước');
      const res = await api('/aliases', {
        method: 'POST',
        body: { mailboxId: domainBox.id, kind: 'domain', purpose: `Mail tạm (${ttl})`, source: 'Quick Temp', expiresAt }
      });
      await navigator.clipboard.writeText(res.address).catch(() => {});
      toast(`Đã tạo & sao chép: ${res.address}`);
      logTicker(`Đã tạo Mail tạm thời: ${res.address} (Thời hạn ${ttl})`);
    }
    else if (action === 'open-message') {
      state.selectedMessage = el.dataset.id;
      for (const item of app.querySelectorAll('[data-action="open-message"]')) item.classList.toggle('selected', item.dataset.id === el.dataset.id);
      await showMessage(el.dataset.id);
    }
    else if (action === 'delete-message') {
      if (!confirm('Xóa thư này?')) return;
      await api(`/messages/${el.dataset.id}`, {method:'DELETE'});
      state.selectedMessage = null;
      toast('Đã xóa thư');
      logTicker(`Đã xóa thư khỏi hộp thư`);
      await render();
    }
    else if (action === 'delete-alias') {
      if (!confirm('Xóa địa chỉ này khỏi danh sách theo dõi?')) return;
      await api(`/aliases/${el.dataset.id}`, {method:'DELETE'});
      toast('Đã xóa địa chỉ');
      logTicker(`Đã xóa địa chỉ khỏi cơ sở dữ liệu`);
      await render();
    }
    else if (action === 'clean-system') {
      const mode = el.dataset.mode || 'quick';
      if (mode === 'full' && !confirm('Ứng dụng sẽ tạo bản sao lưu, sau đó xóa mọi thư và địa chỉ phụ đang lưu. Tài khoản quản trị được giữ lại. Tiếp tục?')) return;
      const resetProof=mode==='full'?document.querySelector('#reset-auth')?.value.trim():'';
      if (mode==='full' && !resetProof) throw new Error('Nhập mật khẩu quản trị hoặc SETUP_TOKEN trong Cài đặt trước khi reset');
      toast('Đang thực hiện dọn dẹp hệ thống...');
      const res = await api('/system/clean', { method: 'POST', body: { mode,password:resetProof,setupToken:resetProof } });
      audioCtx.play('zap');
      if (mode === 'quick') {
        toast(`Đã dọn ${res.expiredAliasesDeleted} địa chỉ hết hạn, ${res.expiredSessionsDeleted} phiên, giải phóng WAL!`);
        logTicker(`Dọn nhanh hoàn tất: ${res.expiredAliasesDeleted} địa chỉ, ${res.expiredOAuthDeleted || 0} OAuth states đã xóa, WAL giải phóng`);
      } else {
        toast(`Đã sao lưu và xóa ${res.messagesDeleted} thư, ${res.aliasesDeleted} địa chỉ`);
        logTicker(`Reset CSDL hoàn tất: Xóa sạch ${res.messagesDeleted} thư & ${res.aliasesDeleted} biến thể`);
        state.selectedMessage = null;
        state.generatedDots = [];
        state.generatedPlus = [];
      }
      await refreshTelemetry();
      await render();
    }
    else if (action === 'mark-all-read') {
      const res = await api('/messages/read-all', { method: 'POST' });
      audioCtx.play('success');
      toast(`Đã đánh dấu ${res.updated} thư là đã đọc`);
      logTicker(`Đã đánh dấu toàn bộ ${res.updated} thư là đã đọc`);
      await render();
    }
    else if (action === 'toggle-unread-filter') {
      state.unreadOnly = el.dataset.val === '1';
      audioCtx.play('click');
      await render();
    }
    else if (action === 'export-messages-json') {
      const res = await api('/messages/export');
      const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json;charset=utf-8' });
      downloadBlob(blob, `mailneon-messages-otp-${Date.now()}.json`);
      audioCtx.play('success');
      toast(`Đã xuất ${res.count} thư và mã OTP thành công!`);
      logTicker(`Đã xuất danh sách ${res.count} thư và mã OTP ra file JSON`);
    }
    else if (action === 'clean-inbox-all') {
      if (!confirm('Bạn có chắc chắn muốn XÓA SẠCH toàn bộ thư trong Hộp thư không?')) return;
      const res = await api('/messages', { method: 'DELETE' });
      state.selectedMessage = null;
      audioCtx.play('zap');
      toast(`Đã dọn sạch ${res.deleted ?? ''} thư trong hộp thư!`);
      logTicker(`Đã xóa sạch ${res.deleted ?? 0} thư trong hộp thư`);
      await render();
    }
    else if (action === 'clean-expired-aliases') {
      const res = await api('/system/clean', { method: 'POST', body: { mode: 'quick' } });
      toast(`Đã xóa ${res.expiredAliasesDeleted} mail tạm đã hết hạn!`);
      logTicker(`Đã xóa ${res.expiredAliasesDeleted} mail tạm hết hạn khỏi CSDL`);
      await render();
    }
    else if (action === 'clean-all-aliases') {
      if (!confirm('CẢNH BÁO: Xóa TOÀN BỘ danh sách địa chỉ đang theo dõi trong cơ sở dữ liệu?')) return;
      const aliases = await api('/aliases?limit=2000');
      for (const a of aliases.items) {
        await api(`/aliases/${a.id}`, { method: 'DELETE' }).catch(() => {});
      }
      toast('Đã xóa toàn bộ biến thể khỏi cơ sở dữ liệu!');
      logTicker('Đã dọn sạch toàn bộ biến thể đang theo dõi');
      await render();
    }
    else if (action === 'clear-generated-view') {
      state.generatedDots = [];
      state.generatedDotsInfo = null;
      state.generatedPlus = [];
      toast('Đã xóa danh sách hiển thị');
      logTicker('Đã xóa sạch danh sách biến thể hiển thị trên giao diện');
      await render();
    }
    else if (action === 'clear-loadtest-logs') {
      state.loadtest.logs = [];
      const con = document.querySelector('#loadtest-console');
      if (con) con.innerHTML = '';
      const countEl = document.querySelector('#log-count');
      if (countEl) countEl.textContent = '0 logs';
      toast('Đã xóa logs');
    }
    else if (action === 'export-loadtest-report') {
      const report = {
        timestamp: new Date().toISOString(),
        metrics: {
          rps: state.loadtest.rps,
          avgLatencyMs: state.loadtest.avgLatency,
          successRate: state.loadtest.successRate,
          totalProcessed: state.loadtest.processed
        },
        logs: state.loadtest.logs
      };
      downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `loadtest-report-${Date.now()}.json`);
      toast('Đã xuất báo cáo kiểm tra tải JSON');
    }
    else if (action === 'reload') location.reload();
    else if (action === 'export') {
      const payload = await api('/export');
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'mail-neon-export.json');
      toast('Đã tải metadata');
    }
    else if (action === 'logout') {
      await api('/logout', {method:'POST'}).catch(() => {});
      state.user = null;
      renderAuth();
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (el.isConnected) el.disabled = false;
  }
});

app.addEventListener('change', async event => {
  const target = event.target;
  if (target.matches('#plus-preset')) {
    state.lastPlusPreset = target.value;
  } else if (target.matches('#dot-count')) {
    state.lastDotCount = target.value;
  } else if (target.matches('#dot-mode')) {
    state.dotMode = target.value;
    const categorized = target.value === 'categorized';
    const wrap = document.querySelector('#dot-pattern-wrap');
    const pattern = document.querySelector('#dot-pattern');
    if (wrap) wrap.hidden = !categorized;
    if (pattern) pattern.disabled = !categorized;
  } else if (target.matches('#dot-pattern')) {
    state.dotPattern = target.value;
  } else if (target.matches('#use-googlemail')) {
    state.dotUseGooglemail = target.checked;
  } else if (target.matches('#plus-count')) {
    state.plusCount = target.value;
  } else if (target.matches('#gen-mode-select')) {
    if (state.plusJob && target.value !== 'plus') state.plusJob.cancelled = true;
    state.generatorTab = target.value;
    audioCtx.play('click');
    await render();
  }
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----------------- FORM SUBMIT HANDLERS -----------------
app.addEventListener('submit', async event => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  const input = Object.fromEntries(new FormData(form).entries());

  try {
    if (form.dataset.form === 'generate-dots') {
      if (!canonicalGmail(input.email)) throw new Error('Dot Trick chỉ dùng với địa chỉ @gmail.com hoặc @googlemail.com. Hotmail được kết nối ở mục Kết nối & Inbound.');
      state.lastDotEmail = input.email;
      state.dotMode = input.mode || 'combined';
      state.dotPattern = input.pattern || state.dotPattern;
      state.lastDotCount = input.count || '50';
      state.dotUseGooglemail = !!form.querySelector('#use-googlemail')?.checked;
      const res = await api('/generator/dots', {
        method: 'POST',
        body: {
          email: input.email,
          count: input.count === 'all' ? 2000 : Number(input.count) || 50,
          mode: state.dotMode,
          pattern: state.dotPattern,
          useGooglemail: state.dotUseGooglemail
        }
      });
      state.generatedDots = res.variants || [];
      state.generatedDotsInfo = res;
      toast(`Đã sinh ${state.generatedDots.length} biến thể Dot Trick!`);
      logTicker(`Sinh thành công ${state.generatedDots.length} địa chỉ Gmail Dot Trick`);
      await render();
    }
    else if (form.dataset.form === 'generate-plus') {
      if (!canonicalGmail(input.email)) throw new Error('Thẻ Plus này chỉ dùng với địa chỉ @gmail.com hoặc @googlemail.com. Hotmail được kết nối ở mục Kết nối & Inbound.');
      if (!/^[1-9][0-9]*$/.test(String(input.count || ''))) throw new Error('Nhập số lượng Thẻ Plus là số nguyên dương');
      state.lastDotEmail = input.email;
      state.lastPlusPreset = input.preset || 'social';
      state.plusCount = input.count;
      state.plusPage = 0;
      state.generatedPlus = [];
      const target = BigInt(input.count);
      let offset = 0n;
      const job = { cancelled: false };
      state.plusJob = job;
      const stopButton = form.querySelector('#stop-plus');
      const progress = form.querySelector('#plus-progress');
      if (stopButton) stopButton.hidden = false;
      try {
        while (offset < target && !job.cancelled) {
          const remaining = target - offset;
          const count = remaining > 2000n ? 2000 : Number(remaining);
          const res = await api('/generator/plus', {
            method: 'POST',
            body: { email: input.email, preset: state.lastPlusPreset, customTag: input.customTag || '', count, offset: offset.toString() }
          });
          if (res.variants?.length !== count) throw new Error('Máy chủ chưa trả đủ biến thể Thẻ Plus');
          state.generatedPlus.push(...res.variants);
          offset += BigInt(count);
          if (progress?.isConnected) progress.textContent = `Đã sinh ${offset.toLocaleString('vi-VN')} / ${target.toLocaleString('vi-VN')} địa chỉ. Bấm Dừng để giữ kết quả hiện có.`;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } finally {
        state.plusJob = null;
        if (state.page === 'generator' && state.generatorTab === 'plus') await render();
      }
      toast(job.cancelled ? `Đã dừng ở ${state.generatedPlus.length} Thẻ Plus` : `Đã sinh ${state.generatedPlus.length} Thẻ Plus!`);
      logTicker(`Sinh ${state.generatedPlus.length} thẻ Plus${job.cancelled ? ' (đã dừng)' : ''}`);
    }
    else if (form.dataset.form === 'loadtest-run') {
      await executeLoadTest(input);
    }
    else if (form.dataset.form === 'search') {
      state.search = input.q || '';
      await render();
    }
    else if (form.dataset.form === 'alias-search') {
      state.aliasSearch = input.q || '';
      await render();
    }
    else if (form.dataset.form === 'imap') {
      await api('/mailboxes/imap', {method:'POST', body:{...input, port:Number(input.port)}});
      toast('Đã kết nối hộp thư IMAP thành công!');
      logTicker(`Đã kết nối hộp thư IMAP: ${input.address}`);
      await render();
    }
    else if (form.dataset.form === 'account-credentials') {
      const result=await api('/account/credentials',{method:'POST',body:input});
      state.user.email=result.email;
      shell();
      await render();
      toast('Đã cập nhật email và mật khẩu quản trị');
    }
    else if (form.dataset.form === 'setup' || form.dataset.form === 'login') {
      const result = await api(`/${form.dataset.form}`, {method:'POST', body:input, auth:false});
      state.user = result.user;
      state.csrf = result.csrf;
      state.autoSession = false;
      state.config = await api('/config', {auth:false});
      shell();
      await render();
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
});

// ----------------- LOAD TEST EXECUTION ENGINE -----------------
async function executeLoadTest({ mode, count, concurrency }) {
  const lt = state.loadtest;
  lt.running = true;
  lt.mode = mode;
  lt.targetCount = Number(count) || 10000;
  lt.concurrency = Number(concurrency) || 25;
  lt.progress = 5;

  const appendLog = (msg, type='info') => {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    lt.logs.unshift(entry);
    if (lt.logs.length > 200) lt.logs.pop();
    const consoleEl = document.querySelector('#loadtest-console');
    if (consoleEl) {
      const div = document.createElement('div');
      div.className = `console-line ${type}`;
      div.textContent = entry;
      consoleEl.prepend(div);
    }
    const countEl = document.querySelector('#log-count');
    if (countEl) countEl.textContent = `${lt.logs.length} logs`;
  };

  const updateProgressBar = pct => {
    lt.progress = pct;
    const bar = document.querySelector('#loadtest-progress-bar');
    if (bar) bar.style.width = `${pct}%`;
  };

  const updateGauges = (rps, lat, success, proc) => {
    lt.rps = rps;
    lt.avgLatency = lat;
    lt.successRate = success;
    lt.processed = proc;
    const gRps = document.querySelector('#gauge-rps');
    if (gRps) gRps.innerHTML = `${rps.toLocaleString()} <span style="font-size:0.9rem">/s</span>`;
    const gLat = document.querySelector('#gauge-lat');
    if (gLat) gLat.innerHTML = `${lat.toFixed(2)} <span style="font-size:0.9rem">ms</span>`;
    const gSuc = document.querySelector('#gauge-success');
    if (gSuc) gSuc.innerHTML = `${success}%`;
    const gProc = document.querySelector('#gauge-proc');
    if (gProc) gProc.innerHTML = proc.toLocaleString();
  };

  appendLog(`>>> BẮT ĐẦU KIỂM TRA TẢI [Chế độ: ${mode.toUpperCase()}] · Mục tiêu: ${lt.targetCount.toLocaleString()} đơn vị · Đa luồng: ${lt.concurrency}`, 'info');
  logTicker(`Đang chạy kịch bản đo tải ${mode} với ${lt.targetCount} đơn vị...`);

  try {
    if (mode === 'generator') {
      appendLog(`Khởi tạo benchmark thuật toán nhị phân 2^(n-1) trên luồng V8...`, 'info');
      updateProgressBar(30);
      const res = await api('/loadtest/bench-generator', {
        method: 'POST',
        body: { count: lt.targetCount, email: 'performance.stress@gmail.com' }
      });
      updateProgressBar(100);
      updateGauges(res.throughputPerSec, res.durationMs / res.count, 100, res.count);
      appendLog(`[HOÀN TẤT] Đã sinh thành công ${res.count.toLocaleString()} biến thể trong ${res.durationMs}ms`, 'success');
      appendLog(`[THÔNG LƯỢNG] Năng lực tính toán: ${res.throughputPerSec.toLocaleString()} biến thể/giây`, 'warn');
      appendLog(`Mẫu biến thể đầu: ${res.sample.join(' | ')}`, 'info');
    }
    else if (mode === 'sqlite_batch') {
      const batchSize = Math.min(lt.targetCount, 5000);
      appendLog(`Mở giao dịch ghi SQLite WAL BEGIN IMMEDIATE cho ${batchSize} bản ghi...`, 'info');
      updateProgressBar(40);
      const res = await api('/loadtest/bench-db', {
        method: 'POST',
        body: { count: batchSize }
      });
      updateProgressBar(100);
      updateGauges(res.tps, res.avgLatencyPerItemMs, 100, res.inserted);
      appendLog(`[HOÀN TẤT GIAO DỊCH] Đã ghi ${res.inserted.toLocaleString()} bản ghi trong ${res.durationMs}ms`, 'success');
      appendLog(`[THÔNG LƯỢNG GHI WAL] Tốc độ TPS: ${res.tps.toLocaleString()} bản ghi/giây`, 'warn');
      appendLog(`[ĐỘ TRỄ TRUNG BÌNH] ${res.avgLatencyPerItemMs}ms/bản ghi`, 'info');
    }
    else if (mode === 'http_burst') {
      const totalReqs = Math.min(lt.targetCount, 200);
      const concurrency = Math.min(lt.concurrency, 50);
      appendLog(`Bắn đồng thời ${totalReqs} yêu cầu HTTP API với ${concurrency} kết nối đồng thời...`, 'info');
      let completed = 0;
      let successes = 0;
      const latencies = [];
      const startTime = performance.now();

      const runBatch = async (batch) => {
        await Promise.all(batch.map(async () => {
          const reqStart = performance.now();
          try {
            await api('/generator/dots', { method: 'POST', body: { email: 'burst.test@gmail.com', count: 10 } });
            successes++;
          } catch {
            // handle error
          }
          const reqEnd = performance.now();
          latencies.push(reqEnd - reqStart);
          completed++;
          updateProgressBar(Math.round((completed / totalReqs) * 100));
        }));
      };

      for (let i = 0; i < totalReqs; i += concurrency) {
        const batch = Array.from({ length: Math.min(concurrency, totalReqs - i) });
        await runBatch(batch);
      }

      const totalTimeMs = performance.now() - startTime;
      const rps = Math.round((totalReqs / (totalTimeMs / 1000)));
      const avgLat = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const successPct = Math.round((successes / totalReqs) * 100);

      updateGauges(rps, avgLat, successPct, totalReqs);
      appendLog(`[HOÀN TẤT HTTP BURST] ${completed}/${totalReqs} hoàn thành trong ${totalTimeMs.toFixed(1)}ms`, 'success');
      appendLog(`[THÔNG LƯỢNG MẠNG] Đạt ${rps.toLocaleString()} RPS (Requests Per Second)`, 'warn');
      appendLog(`[ĐỘ TRỄ P50] ${avgLat.toFixed(2)}ms`, 'info');
    }

    toast('Kiểm tra tải hoàn tất thành công!');
    logTicker(`Kiểm tra tải ${mode} hoàn tất: Đạt thông lượng ${lt.rps.toLocaleString()}/s`);
  } catch (err) {
    appendLog(`[LỖI THỰC THI] ${err.message}`, 'error');
    toast(`Lỗi đo tải: ${err.message}`, true);
  } finally {
    lt.running = false;
    const btn = document.querySelector('#btn-run-loadtest');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🚀 BẮT ĐẦU KIỂM TRA TẢI TRỌNG (START TEST)';
    }
  }
}

// ----------------- BOOTSTRAP -----------------
async function boot() {
  try {
    state.config = await api('/config', {auth:false});
    const params=new URLSearchParams(location.search);
    if (params.has('connected')) {toast('Đã kết nối hộp thư');history.replaceState(null,'','/');}
    if (params.has('connection_error')) {toast('Kết nối OAuth thất bại; kiểm tra cấu hình rồi thử lại',true);history.replaceState(null,'','/');}

    if (!state.config.setupRequired) {
      try {
        const me = await api('/me');
        state.user = me.user;
        state.csrf = me.csrf;
        state.autoSession = !!me.autoSession;
      } catch {}
    }

    if (state.user) {
      shell();
      render();
    } else {
      renderAuth();
    }
  } catch (error) {
    app.innerHTML = `<div class="auth-wrap"><div class="notice error">Không thể kết nối máy chủ: ${esc(error.message)}<br><button class="btn small" data-action="reload" style="margin-top:10px">Thử lại</button></div></div>`;
  }
}

boot();
